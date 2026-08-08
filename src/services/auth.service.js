const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');
const ApiError = require('../utils/ApiError');
const config = require('../config');
const { sanitizeUser } = require('../utils/sanitize');

const parseExpiryMs = (str) => {
  const match = /^(\d+)([smhd])$/.exec(str);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const units = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return Number(match[1]) * units[match[2]];
};

const generateAccessToken = (user) => {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, config.jwtSecret, {
    expiresIn: config.accessTokenExpiresIn,
  });
};

const generateRefreshToken = () => crypto.randomBytes(48).toString('hex');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const createRefreshTokenRecord = async (userId) => {
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + parseExpiryMs(config.refreshTokenExpiresIn));
  await prisma.refreshToken.create({
    data: { userId, tokenHash: hashToken(refreshToken), expiresAt },
  });
  return refreshToken;
};

const issueTokenPair = async (user) => {
  const accessToken = generateAccessToken(user);
  const refreshToken = await createRefreshTokenRecord(user.id);
  return { accessToken, refreshToken };
};

const register = async ({ email, password, name }) => {
  const normalizedEmail = String(email).toLowerCase();
  const exists = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (exists) throw new ApiError(409, 'Email already registered');

  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
  const user = await prisma.user.create({ data: { email: normalizedEmail, name, passwordHash } });

  const tokens = await issueTokenPair(user);
  return { ...tokens, user: sanitizeUser(user) };
};

const login = async ({ email, password }) => {
  const normalizedEmail = String(email).toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (!user) throw new ApiError(401, 'Invalid email or password');

  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) throw new ApiError(401, 'Invalid email or password');
  if (!user.isActive) throw new ApiError(403, 'Account is inactive');

  const tokens = await issueTokenPair(user);
  return { ...tokens, user: sanitizeUser(user) };
};

const refresh = async (refreshToken) => {
  if (!refreshToken) throw new ApiError(401, 'Refresh token required');

  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(refreshToken) },
  });
  if (!record) throw new ApiError(401, 'Invalid refresh token');

  if (record.revokedAt) {
    // Reuse of a rotated/revoked token = possible theft; kill all sessions
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

  // Rotate: revoke the used token, issue a fresh one
  await prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
  const accessToken = generateAccessToken(user);
  const newRefreshToken = await createRefreshTokenRecord(user.id);

  return { accessToken, refreshToken: newRefreshToken, user: sanitizeUser(user) };
};

const logout = async (refreshToken) => {
  if (!refreshToken) throw new ApiError(400, 'Refresh token required');
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(refreshToken) },
  });
  if (record && !record.revokedAt) {
    await prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
  }
  return { message: 'Logged out successfully' };
};

const logoutAll = async (userId) => {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return { message: 'Logged out from all devices' };
};

module.exports = { register, login, refresh, logout, logoutAll };
