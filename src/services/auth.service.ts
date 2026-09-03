import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import config from '../config';
import { sanitizeUser } from '../utils/sanitize';
import type { User } from '@prisma/client';

const parseExpiryMs = (str: string): number => {
  const match = /^(\d+)([smhd])$/.exec(str);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const units: Record<string, number> = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return Number(match[1]) * units[match[2]];
};

const generateAccessToken = (user: Pick<User, 'id' | 'email' | 'role'>): string => {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, config.jwtSecret, {
    expiresIn: config.accessTokenExpiresIn as string & { toString(): string },
  } as jwt.SignOptions);
};

const generateRefreshToken = (): string => crypto.randomBytes(48).toString('hex');
const hashToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

const createRefreshTokenRecord = async (userId: string): Promise<string> => {
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + parseExpiryMs(config.refreshTokenExpiresIn));
  await prisma.refreshToken.create({
    data: { userId, tokenHash: hashToken(refreshToken), expiresAt },
  });
  return refreshToken;
};

const issueTokenPair = async (
  user: Pick<User, 'id' | 'email' | 'role'>
): Promise<{ accessToken: string; refreshToken: string }> => {
  const accessToken = generateAccessToken(user);
  const refreshToken = await createRefreshTokenRecord(user.id);
  return { accessToken, refreshToken };
};

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export const register = async ({ email, password, name }: RegisterInput) => {
  const normalizedEmail = String(email).toLowerCase();
  const exists = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (exists) throw new ApiError(409, 'Email already registered');

  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
  const user = await prisma.user.create({ data: { email: normalizedEmail, name, passwordHash } });

  const tokens = await issueTokenPair(user);
  return { ...tokens, user: sanitizeUser(user) };
};

export const login = async ({ email, password }: LoginInput) => {
  const normalizedEmail = String(email).toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (!user) throw new ApiError(401, 'Invalid email or password');

  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) throw new ApiError(401, 'Invalid email or password');
  if (!user.isActive) throw new ApiError(403, 'Account is inactive');

  const tokens = await issueTokenPair(user);
  return { ...tokens, user: sanitizeUser(user) };
};

export const refresh = async (refreshToken: string) => {
  if (!refreshToken) throw new ApiError(401, 'Refresh token required');

  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(refreshToken) },
  });
  if (!record) throw new ApiError(401, 'Invalid refresh token');

  if (record.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new ApiError(401, 'Refresh token reuse detected, all sessions revoked');
  }
  if (record.expiresAt <= new Date()) {
    throw new ApiError(401, 'Refresh token expired');
  }

  const user = await prisma.user.findUnique({ where: { id: record.userId } });
  if (!user || !user.isActive) throw new ApiError(401, 'User not found or inactive');

  await prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
  const accessToken = generateAccessToken(user);
  const newRefreshToken = await createRefreshTokenRecord(user.id);

  return { accessToken, refreshToken: newRefreshToken, user: sanitizeUser(user) };
};

export const logout = async (refreshToken: string) => {
  if (!refreshToken) throw new ApiError(400, 'Refresh token required');
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(refreshToken) },
  });
  if (record && !record.revokedAt) {
    await prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
  }
  return { message: 'Logged out successfully' };
};

export const logoutAll = async (userId: string) => {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return { message: 'Logged out from all devices' };
};

export const changePassword = async (userId: string, currentPassword: string, newPassword: string) => {
  if (!currentPassword || !newPassword) throw new ApiError(400, 'Current and new password required');
  if (String(newPassword).length < 6) throw new ApiError(400, 'New password must be at least 6 characters');

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError(404, 'User not found');

  const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!isMatch) throw new ApiError(400, 'Current password is incorrect');

  const passwordHash = await bcrypt.hash(newPassword, config.bcryptRounds);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });

  // Revoke all other sessions for security on password change
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  return { message: 'Password changed successfully' };
};
