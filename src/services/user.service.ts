import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';

export const getUserById = async (id: string) => {
  const user = await prisma.user.findUnique({
    where: { id },
    include: { _count: { select: { bets: true, transactions: true } } },
  });
  if (!user) throw new ApiError(404, 'User not found');
  return user;
};

export const listUsers = async (filters: Record<string, unknown> = {}) => {
  const where: Record<string, unknown> = {};
  if (filters.role && typeof filters.role === 'string') {
    where.role = filters.role;
  }
  if (filters.isActive !== undefined) {
    where.isActive = filters.isActive === 'true' || filters.isActive === true;
  }
  if (filters.search && typeof filters.search === 'string' && filters.search.trim()) {
    const s = filters.search.trim();
    where.OR = [
      { email: { contains: s } },
      { name: { contains: s } },
    ];
  }

  // Pagination
  const page = Math.max(1, parseInt(String(filters.page ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(filters.limit ?? '50'), 10) || 50));
  const skip = (page - 1) * limit;

  const [total, data] = await Promise.all([
    prisma.user.count({ where: where as never }),
    prisma.user.findMany({
      where: where as never,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        balance: true,
        isActive: true,
        emailVerified: true,
        themeMode: true,
        themeColor: true,
        createdAt: true,
        updatedAt: true,
        lastLoginAt: true,
        _count: { select: { bets: true, transactions: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
  ]);

  return {
    data,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
};

const THEME_MODES = ["LIGHT", "DARK", "SYSTEM"] as const;

export const updateUser = async (id: string, updates: Record<string, unknown>) => {
  const allowed: Record<string, unknown> = {};
  if (updates.name !== undefined) allowed.name = String(updates.name).trim() || null;
  if (updates.themeColor !== undefined) {
    const c = String(updates.themeColor).trim();
    if (c.length > 20) throw new ApiError(400, 'Invalid theme color');
    allowed.themeColor = c || "blue";
  }
  if (updates.themeMode !== undefined) {
    const m = String(updates.themeMode).toUpperCase();
    if (!THEME_MODES.includes(m as never)) throw new ApiError(400, 'Invalid theme mode');
    allowed.themeMode = m;
  }
  // Payout account (user-editable at any time; used as default for withdrawals)
  const payoutFields = ['payoutAccountType', 'payoutAccountNumber', 'payoutAccountUsername'] as const;
  for (const field of payoutFields) {
    if (updates[field] !== undefined) {
      const v = String(updates[field]).trim();
      if (v.length > 100) throw new ApiError(400, `Invalid ${field}`);
      allowed[field] = v || null;
    }
  }
  // keep backward compat for old 'name' only updates via /me
  const hasTheme = allowed.themeColor !== undefined || allowed.themeMode !== undefined;
  const hasName = updates.name !== undefined;
  const hasPayout = payoutFields.some((f) => allowed[f] !== undefined);
  if (!hasTheme && !hasName && !hasPayout) {
    // fallback to old strict name-only check for compatibility
    const allowedFields = ['name'] as const;
    const data: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (updates[field] !== undefined) data[field] = updates[field];
    }
    if (Object.keys(data).length === 0) throw new ApiError(400, 'No valid fields to update');
    const user = await prisma.user.update({ where: { id }, data });
    return user;
  }
  if (Object.keys(allowed).length === 0) throw new ApiError(400, 'No valid fields to update');
  const user = await prisma.user.update({ where: { id }, data: allowed });
  return user;
};

export const updateUserByAdmin = async (id: string, updates: Record<string, unknown>, actorId: string) => {
  const allowed: Record<string, unknown> = {};
  if (updates.name !== undefined) allowed.name = String(updates.name).trim() || null;
  if (updates.role !== undefined) {
    const r = String(updates.role);
    if (!['USER', 'ADMIN', 'ODDS_MANAGER'].includes(r)) throw new ApiError(400, 'Invalid role');
    allowed.role = r;
  }
  if (updates.isActive !== undefined) allowed.isActive = Boolean(updates.isActive);
  if (updates.balance !== undefined) {
    const b = Number(updates.balance);
    if (Number.isNaN(b) || b < 0) throw new ApiError(400, 'Invalid balance');
    allowed.balance = b;
  }
  if (updates.emailVerified !== undefined) allowed.emailVerified = Boolean(updates.emailVerified);
  if (updates.themeColor !== undefined) {
    const c = String(updates.themeColor).trim();
    if (c.length > 20) throw new ApiError(400, 'Invalid theme color');
    allowed.themeColor = c || "blue";
  }
  if (updates.themeMode !== undefined) {
    const m = String(updates.themeMode).toUpperCase();
    if (!THEME_MODES.includes(m as never)) throw new ApiError(400, 'Invalid theme mode');
    allowed.themeMode = m;
  }

  if (Object.keys(allowed).length === 0) throw new ApiError(400, 'No valid fields to update');

  // Attribute direct role/isActive/balance changes to the acting admin
  const directChange = allowed.role !== undefined || allowed.isActive !== undefined || allowed.balance !== undefined;
  const user = await prisma.user.update({
    where: { id },
    data: { ...allowed, ...(directChange ? { lastModifiedById: actorId } : {}) },
  });
  return user;
};

export const deleteUser = async (id: string) => {
  const user = await prisma.user.findUnique({
    where: { id },
    include: { _count: { select: { bets: true, transactions: true } } },
  });
  if (!user) throw new ApiError(404, 'User not found');

  // Prevent deleting self? Let controller handle, but service can check
  const hasBets = user._count.bets > 0 || user._count.transactions > 0;
  if (hasBets) {
    // Soft delete: deactivate and revoke tokens
    await prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    const updated = await prisma.user.update({ where: { id }, data: { isActive: false } });
    return { soft: true, user: updated, message: 'User has transactions, deactivated instead of hard delete' };
  }

  await prisma.refreshToken.deleteMany({ where: { userId: id } });
  // AdminActionLog has Restrict, so delete those first
  await prisma.adminActionLog.deleteMany({ where: { userId: id } });

  await prisma.user.delete({ where: { id } });
  return { soft: false, message: 'User deleted' };
};

// ============================================
// ADMIN: Devices & Referral listings
// ============================================

export const listAllDevices = async (filters: Record<string, unknown> = {}) => {
  const where: Record<string, unknown> = {};
  if (filters.userId && typeof filters.userId === 'string') where.userId = filters.userId;

  const devices = await prisma.device.findMany({
    where: where as never,
    include: {
      user: { select: { id: true, email: true, name: true, role: true } },
      _count: { select: { refreshTokens: true } },
    },
    orderBy: { lastSeenAt: 'desc' },
    take: 500,
  });
  return devices;
};

export const listReferralBonuses = async () => {
  const referrals = await prisma.referral.findMany({
    where: { status: 'REWARDED' },
    include: {
      referrer: { select: { id: true, email: true, name: true } },
      referee: { select: { id: true, email: true, name: true } },
    },
    orderBy: { rewardedAt: 'desc' },
  });

  // Attach the bonus payout transaction (for amount verification)
  const referrerIds = Array.from(new Set(referrals.map((r) => r.referrerId)));
  const bonusTx = await prisma.transaction.findMany({
    where: { userId: { in: referrerIds }, type: 'REFERRAL_BONUS' },
    orderBy: { createdAt: 'desc' },
  });
  const txByReferralId = new Map<string, (typeof bonusTx)[number]>();
  for (const t of bonusTx) {
    const m = /^referral:(.+)$/.exec(t.reference ?? '');
    if (m && !txByReferralId.has(m[1])) txByReferralId.set(m[1], t);
  }

  return referrals.map((r) => ({
    id: r.id,
    referrer: r.referrer,
    referee: r.referee,
    codeUsed: r.codeUsed,
    bonusAmount: r.bonusAmount,
    qualifiedAt: r.qualifiedAt,
    rewardedAt: r.rewardedAt,
    createdAt: r.createdAt,
    transaction: txByReferralId.get(r.id) ?? null,
  }));
};
