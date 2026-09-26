import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import config from '../config';
import { sanitizeUser } from '../utils/sanitize';
import { notify } from './notification.service';
import { getBoolSetting } from './settings.service';
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
  secondReferralCode?: string;
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
  { email, password, name, referralCode, secondReferralCode }: RegisterInput,
  meta?: RequestMeta
) => {
  const normalizedEmail = String(email).toLowerCase();
  const exists = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (exists) throw new ApiError(409, 'Email already registered');

  // Agent gate: when registration.require_agent is ON, signup only succeeds if
  // an agent is detected (manual second code wins, else an agent's ?ref= link).
  const requireAgent = await getBoolSetting('registration.require_agent', false);
  const manual = typeof secondReferralCode === 'string' ? secondReferralCode.trim() : '';
  const linkCode = typeof referralCode === 'string' ? referralCode.trim() : '';
  let agent: { id: string } | null = null;
  let agentCode = '';
  let agentCodeType: 'PRIMARY' | 'SECONDARY' = 'PRIMARY';
  if (manual) {
    const match = await prisma.user.findFirst({
      where: { second_referralCode: manual, role: 'AGENT', isActive: true },
      select: { id: true },
    });
    if (match && match.id !== undefined) {
      agent = match;
      agentCode = manual;
      agentCodeType = 'SECONDARY';
    }
  }
  let linkReferrer: { id: string } | null = null;
  if (!agent && linkCode) {
    const found = await prisma.user.findUnique({
      where: { referralCode: linkCode },
      select: { id: true, role: true, isActive: true },
    });
    if (found && found.id !== undefined && found.isActive && (!requireAgent || found.role === 'AGENT')) {
      linkReferrer = found;
    }
  }
  if (requireAgent && !agent && !linkReferrer) {
    throw new ApiError(400, 'Registration requires a valid agent referral code.');
  }

  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);

  // Referral capture — invalid/self codes are silently ignored, never block signup
  // (unless require_agent mode already rejected above).
  const referrer = agent ?? linkReferrer;
  const codeUsed = agent ? agentCode : linkCode;
  let referralRecorded = false;

  const createUserData = {
    email: normalizedEmail,
    name,
    passwordHash,
    lastLoginAt: new Date(),
    lastLoginIp: meta?.ip ?? null,
  };

  if (requireAgent && referrer) {
    // Atomic: the user exists only if the referral row is recorded. If the
    // referral write fails, the whole registration is cancelled (rolled back).
    try {
      const created = await prisma.$transaction(async (tx) => {
        const u = await tx.user.create({ data: createUserData });
        if (referrer.id === u.id) throw new ApiError(400, 'Invalid referral.');
        await tx.referral.create({
          data: { referrerId: referrer.id, refereeId: u.id, codeUsed, codeType: agentCodeType, status: 'PENDING' },
        });
        return u;
      });
      var user = created;
      referralRecorded = true;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(400, 'Registration failed: the agent referral could not be recorded, please try again.');
    }
  } else {
    var user = await prisma.user.create({ data: createUserData });
    if (referrer && referrer.id !== user.id) {
      try {
        await prisma.referral.create({
          data: { referrerId: referrer.id, refereeId: user.id, codeUsed, codeType: agentCodeType, status: 'PENDING' },
        });
        referralRecorded = true;
      } catch {
        // open mode: a referral write failure never blocks signup
      }
    }
  }

  if (referralRecorded && referrer) {
    await notify({
      audience: 'USER',
      userId: referrer.id,
      type: 'REFERRAL_SIGNUP',
      title: 'Someone joined with your link',
      message: `${user.name ?? user.email} signed up with your referral ${agent ? 'code' : 'link'}`,
      linkUrl: '/profile',
    });
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
  const trimmed = code.trim();
  if (!trimmed) return { found: false as const };
  // Primary codes (any active user) first — existing ?ref= behaviour unchanged
  const user = await prisma.user.findUnique({
    where: { referralCode: trimmed },
    select: { name: true, isActive: true, role: true, second_referralCode: true },
  });
  if (user && user.isActive) {
    const isAgent = user.role === 'AGENT';
    return {
      found: true as const,
      name: user.name ?? 'A friend',
      codeType: 'PRIMARY' as const,
      isAgent,
      // Lets signup auto-fill the agent's second code (editable). Only agents have one.
      secondCode: isAgent ? user.second_referralCode ?? null : null,
    };
  }
  // Manual-box codes: an active AGENT's second code
  const agent = await prisma.user.findFirst({
    where: { second_referralCode: trimmed, role: 'AGENT', isActive: true },
    select: { name: true, second_referralCode: true },
  });
  if (agent) {
    return {
      found: true as const,
      name: agent.name ?? 'A friend',
      codeType: 'SECONDARY' as const,
      isAgent: true as const,
      secondCode: agent.second_referralCode,
    };
  }
  return { found: false as const };
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
