import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import config from '../config';
import { sanitizeUser } from '../utils/sanitize';
import { notify } from './notification.service';
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

const createRefreshTokenRecord = async (userId: string, deviceId?: string | null): Promise<string> => {
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + parseExpiryMs(config.refreshTokenExpiresIn));
  await prisma.refreshToken.create({
    data: { userId, deviceId: deviceId ?? undefined, tokenHash: hashToken(refreshToken), expiresAt },
  });
  return refreshToken;
};

// ============================================
// DEVICE TRACKING
// Parses UA, upserts a Device row keyed by
// (userId, fingerprint), returns the device id.
// Best-effort: never blocks login on failure.
// ============================================
import UAParser from 'ua-parser-js';

const parseDeviceType = (ua: UAParser.IResult): 'DESKTOP' | 'MOBILE' | 'TABLET' | 'UNKNOWN' => {
  if (ua.device.type === 'mobile') return 'MOBILE';
  if (ua.device.type === 'tablet') return 'TABLET';
  if (!ua.device.type && ua.os.name) return 'DESKTOP';
  return 'UNKNOWN';
};

export const trackDevice = async (
  userId: string,
  ip: string,
  userAgent: string | undefined
): Promise<string | null> => {
  try {
    if (!userAgent) return null;
    const ua = UAParser(userAgent);
    const fingerprint = crypto
      .createHash('sha256')
      .update(`${ua.browser.name ?? '?'}|${ua.os.name ?? '?'}|${ua.device.model ?? ''}`)
      .digest('hex');
    const deviceType = parseDeviceType(ua);
    const deviceName = [ua.browser.name, ua.os.name].filter(Boolean).join(' on ') || 'Unknown device';

    const device = await prisma.device.upsert({
      where: { userId_deviceFingerprint: userId_deviceFingerprint(userId, fingerprint) },
      create: {
        userId,
        deviceFingerprint: fingerprint,
        deviceType,
        deviceName,
        os: ua.os.name ? `${ua.os.name}${ua.os.version ? ` ${ua.os.version}` : ''}` : null,
        browser: ua.browser.name ? `${ua.browser.name}${ua.browser.version ? ` ${ua.browser.version.split('.')[0]}` : ''}` : null,
        ipAddress: ip,
        location: (await lookupLocation(ip)) ?? undefined,
        lastSeenAt: new Date(),
      },
      update: {
        ipAddress: ip,
        lastSeenAt: new Date(),
      },
    });
    return device.id;
  } catch {
    return null;
  }
};

const userId_deviceFingerprint = (userId: string, fingerprint: string) => ({ userId, deviceFingerprint: fingerprint });

// Best-effort geolocation for the admin devices list: "City, Country" or null.
const isPrivateIp = (ip: string): boolean =>
  !ip ||
  ip === '::1' ||
  ip === 'unknown' ||
  ip.startsWith('127.') ||
  ip.startsWith('10.') ||
  ip.startsWith('192.168.') ||
  ip.startsWith('172.16.') ||
  ip.startsWith('172.17.') ||
  ip.startsWith('172.18.') ||
  ip.startsWith('172.19.') ||
  ip.startsWith('172.2') ||
  ip.startsWith('172.30.') ||
  ip.startsWith('172.31.') ||
  ip.startsWith('169.254.') ||
  ip.startsWith('::ffff:127.') ||
  ip.startsWith('fc') ||
  ip.startsWith('fd');

const lookupLocation = async (ip: string): Promise<string | null> => {
  try {
    if (isPrivateIp(ip)) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,country`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    const data = (await res.json()) as { status?: string; city?: string; country?: string };
    if (data.status !== 'success') return null;
    return [data.city, data.country].filter(Boolean).join(', ') || null;
  } catch {
    return null;
  }
};

const issueTokenPair = async (
  user: Pick<User, 'id' | 'email' | 'role'>,
  deviceId?: string | null
): Promise<{ accessToken: string; refreshToken: string }> => {
  const accessToken = generateAccessToken(user);
  const refreshToken = await createRefreshTokenRecord(user.id, deviceId);
  return { accessToken, refreshToken };
};

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  referralCode?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface RequestMeta {
  ip: string;
  userAgent?: string;
}

export const register = async (
  { email, password, name, referralCode }: RegisterInput,
  meta?: RequestMeta
) => {
  const normalizedEmail = String(email).toLowerCase();
  const exists = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (exists) throw new ApiError(409, 'Email already registered');

  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
  const user = await prisma.user.create({
    data: {
      email: normalizedEmail,
      name,
      passwordHash,
      lastLoginAt: new Date(),
      lastLoginIp: meta?.ip ?? null,
    },
  });

  // Referral capture — invalid/self codes are silently ignored, never block signup
  if (referralCode && typeof referralCode === 'string') {
    const code = referralCode.trim();
    if (code) {
      const referrer = await prisma.user.findUnique({ where: { referralCode: code } });
      if (referrer && referrer.id !== user.id) {
        await prisma.referral.create({
          data: { referrerId: referrer.id, refereeId: user.id, codeUsed: code, status: 'PENDING' },
        });
        await notify({
          audience: 'USER',
          userId: referrer.id,
          type: 'REFERRAL_SIGNUP',
          title: 'Someone joined with your link',
          message: `${user.name ?? user.email} signed up with your referral link`,
          linkUrl: '/profile',
        });
      }
    }
  }

  await notify({
    audience: 'ADMIN',
    userId: user.id,
    type: 'USER_REGISTERED',
    title: `New user: ${user.name ?? user.email}`,
    message: user.email,
    linkUrl: '/admin/users',
  });

  const deviceId = meta ? await trackDevice(user.id, meta.ip, meta.userAgent) : null;
  const tokens = await issueTokenPair(user, deviceId);
  return { ...tokens, user: sanitizeUser(user) };
};

export const getReferralInfo = async (code: string) => {
  if (!code || typeof code !== 'string') return { found: false as const };
  const user = await prisma.user.findUnique({
    where: { referralCode: code.trim() },
    select: { name: true, isActive: true },
  });
  if (!user || !user.isActive) return { found: false as const };
  return { found: true as const, name: user.name ?? 'A friend' };
};

export const login = async ({ email, password }: LoginInput, meta?: RequestMeta) => {
  const normalizedEmail = String(email).toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (!user) throw new ApiError(401, 'Invalid email or password');

  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) throw new ApiError(401, 'Invalid email or password');
  if (!user.isActive) throw new ApiError(403, 'Account is inactive');

  // Login audit trail (non-fatal)
  try {
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), lastLoginIp: meta?.ip ?? null },
    });
  } catch {}

  const deviceId = meta ? await trackDevice(user.id, meta.ip, meta.userAgent) : null;
  const tokens = await issueTokenPair(user, deviceId);
  return { ...tokens, user: sanitizeUser(user) };
};

export const refresh = async (refreshToken: string, meta?: RequestMeta) => {
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
  const deviceId = meta ? await trackDevice(user.id, meta.ip, meta.userAgent) : null;
  const accessToken = generateAccessToken(user);
  const newRefreshToken = await createRefreshTokenRecord(user.id, deviceId);

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
