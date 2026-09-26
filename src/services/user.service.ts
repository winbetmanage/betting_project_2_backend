import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import { normalizeRole } from '../constants/roles';

/** Roles a sub-admin is allowed to see in the people lists. */
export const NON_STAFF_ROLES: string[] = ['USER', 'AGENT'];

/** Staff roles that are hidden from sub-admins everywhere. */
export const isStaffRole = (role?: string | null): boolean =>
  !!role && !NON_STAFF_ROLES.includes(role);

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
  const requestedRole = filters.role && typeof filters.role === 'string' ? filters.role : null;
  const nonStaffOnly = filters.nonStaffOnly === 'true' || filters.nonStaffOnly === true;
  if (requestedRole) {
    // A sub-admin may only ever narrow the role down to players/agents, never widen it back to staff.
    if (nonStaffOnly) {
      where.role = NON_STAFF_ROLES.includes(requestedRole) ? requestedRole : { in: NON_STAFF_ROLES };
    } else {
      where.role = requestedRole;
    }
  } else if (nonStaffOnly) {
    // Sub-admins may only ever see players and agents, never staff accounts.
    where.role = { in: NON_STAFF_ROLES };
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
        referredAs: { select: { referrer: { select: { id: true, name: true } } } },
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
    if (!['USER', 'ADMIN', 'ODDS_MANAGER', 'AGENT', 'SUBADMIN', 'SUB_ADMIN'].includes(r))
      throw new ApiError(400, 'Invalid role');
    // Persist the spelling the database enum actually uses.
    allowed.role = normalizeRole(r);
  }
  if (updates.second_referralCode !== undefined) {
    const code = String(updates.second_referralCode).trim();
    if (code) {
      // Unique across BOTH code columns (Prisma can't do cross-column unique)
      const [clashPrimary, clashSecond] = await Promise.all([
        prisma.user.findFirst({ where: { referralCode: code, id: { not: id } }, select: { id: true } }),
        prisma.user.findFirst({ where: { second_referralCode: code, id: { not: id } }, select: { id: true } }),
      ]);
      if (clashPrimary || clashSecond) throw new ApiError(409, 'This code is already in use by another account');
      allowed.second_referralCode = code;
    } else {
      allowed.second_referralCode = null;
    }
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

  // Attribute direct role/isActive/balance/code changes to the acting admin
  const directChange = allowed.role !== undefined || allowed.isActive !== undefined || allowed.balance !== undefined || allowed.second_referralCode !== undefined;
  const user = await prisma.user.update({
    where: { id },
    data: { ...allowed, ...(directChange ? { lastModifiedById: actorId } : {}) },
    include: { _count: { select: { bets: true, transactions: true } } },
  });
  return user;
};

/**
 * Sub-admin role switch: strictly USER <-> AGENT and nothing else.
 * Rejects staff targets, self-changes, no-op switches, and any role outside
 * the two non-staff roles. Attributed to the acting sub-admin via
 * `lastModifiedById` (same as main-admin changes).
 */
export const switchRoleBySubAdmin = async (targetId: string, nextRole: unknown, actorId: string) => {
  const next = typeof nextRole === 'string' ? nextRole : '';
  if (!NON_STAFF_ROLES.includes(next)) {
    throw new ApiError(403, 'Sub-admins may only switch accounts between USER and AGENT');
  }
  if (targetId === actorId) throw new ApiError(403, 'You cannot change your own account type');
  const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true, role: true } });
  if (!target) throw new ApiError(404, 'User not found');
  if (isStaffRole(target.role)) throw new ApiError(403, 'Not allowed to change this account');
  if (target.role === next) {
    throw new ApiError(400, `This account is already ${next === 'AGENT' ? 'an agent' : 'a user'}`);
  }
  return updateUserByAdmin(targetId, { role: next }, actorId);
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
// SELF: referrals made by the logged-in user (agent dashboard)
// ============================================

export const listMyReferrals = async (userId: string) => {
  const referrals = await prisma.referral.findMany({
    where: { referrerId: userId },
    include: {
      referee: { select: { id: true, email: true, name: true, isActive: true, createdAt: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return referrals;
};

// ============================================
// ADMIN: per-user detail additions (user detail page)
// ============================================

/** Full betting history of one user, with legs for the history table. */
export const listUserBets = async (userId: string) => {
  return prisma.bet.findMany({
    where: { userId },
    include: {
      selections: {
        include: { selection: { include: { market: { include: { game: { select: { homeTeam: true, awayTeam: true } } } } } } },
      },
    },
    orderBy: { placedAt: 'desc' },
  });
};

/** The upline agent/referrer a user registered with (null = registered directly). */
export const getUserUpline = async (userId: string) => {
  const referral = await prisma.referral.findUnique({
    where: { refereeId: userId },
    include: {
      referrer: { select: { id: true, email: true, name: true, role: true } },
    },
  });
  if (!referral) return null;
  return {
    referrer: referral.referrer,
    codeUsed: referral.codeUsed,
    codeType: referral.codeType,
    status: referral.status,
    bonusAmount: referral.bonusAmount,
    createdAt: referral.createdAt,
    rewardedAt: referral.rewardedAt,
  };
};

/** Everyone registered via an agent's link, with per-user money/bet aggregates. */
export const listReferredUsers = async (userId: string) => {
  const referrals = await prisma.referral.findMany({
    where: { referrerId: userId },
    include: {
      referee: { select: { id: true, email: true, name: true, isActive: true, createdAt: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  const ids = referrals.map((r) => r.refereeId);
  const stats = new Map<string, { depositTotal: number; betCount: number; wonTotal: number; lostTotal: number; lastBetAt: Date | null }>();
  for (const id of ids) stats.set(id, { depositTotal: 0, betCount: 0, wonTotal: 0, lostTotal: 0, lastBetAt: null });
  if (ids.length > 0) {
    const [deposits, bets] = await Promise.all([
      prisma.fundRequest.findMany({
        where: { userId: { in: ids }, type: 'DEPOSIT', status: 'APPROVED' },
        select: { userId: true, amount: true },
      }),
      prisma.bet.findMany({
        where: { userId: { in: ids } },
        select: { userId: true, stake: true, status: true, settledPayout: true, placedAt: true },
      }),
    ]);
    for (const d of deposits) {
      const s = stats.get(d.userId);
      if (s) s.depositTotal += Number(d.amount);
    }
    for (const b of bets) {
      const s = stats.get(b.userId);
      if (!s) continue;
      s.betCount += 1;
      if (b.status === 'WON') s.wonTotal += Number(b.settledPayout);
      if (b.status === 'LOST') s.lostTotal += Number(b.stake);
      if (!s.lastBetAt || b.placedAt > s.lastBetAt) s.lastBetAt = b.placedAt;
    }
  }
  return referrals.map((r) => ({
    id: r.id,
    codeUsed: r.codeUsed,
    status: r.status,
    createdAt: r.createdAt,
    rewardedAt: r.rewardedAt,
    referee: r.referee,
    stats: stats.get(r.refereeId) ?? { depositTotal: 0, betCount: 0, wonTotal: 0, lostTotal: 0, lastBetAt: null },
  }));
};

/** Referral totals for one agent, including the 7/15/30-day windows. */
export type AgentStats = {
  referred: number;
  referred7: number;
  referred15: number;
  referred30: number;
  /** Referred users whose approved deposits total 100 ETB or more, all time. */
  funded100: number;
  depositTotal: number;
};

const DAY = 24 * 60 * 60 * 1000;

export const buildAgentStats = (refs: Awaited<ReturnType<typeof listReferredUsers>>, now = new Date()): AgentStats => {
  const since = (days: number) => new Date(now.getTime() - days * DAY);
  const d7 = since(7);
  const d15 = since(15);
  const d30 = since(30);
  let referred7 = 0;
  let referred15 = 0;
  let referred30 = 0;
  let funded100 = 0;
  let depositTotal = 0;
  for (const r of refs) {
    const at = new Date(r.createdAt);
    if (at >= d30) referred30 += 1;
    if (at >= d15) referred15 += 1;
    if (at >= d7) referred7 += 1;
    if (r.stats.depositTotal >= 100) funded100 += 1;
    depositTotal += r.stats.depositTotal;
  }
  return { referred: refs.length, referred7, referred15, referred30, funded100, depositTotal };
};

/** Every AGENT account with referral stats for the admin Agents list. */
export const listAgentsOverview = async () => {
  const agents = await prisma.user.findMany({
    where: { role: 'AGENT' },
    select: {
      id: true, email: true, name: true, role: true, isActive: true,
      emailVerified: true, referralCode: true, second_referralCode: true, balance: true,
      createdAt: true, lastLoginAt: true,
      _count: { select: { bets: true, transactions: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return Promise.all(
    agents.map(async (a) => ({
      ...a,
      stats: buildAgentStats(await listReferredUsers(a.id)),
    }))
  );
};

/** Referral stats for a single agent (used by the sub-admin agent detail page). */
export const getAgentStats = async (agentId: string) => {
  const agent = await prisma.user.findUnique({
    where: { id: agentId },
    select: {
      id: true, email: true, name: true, role: true, isActive: true, balance: true,
      emailVerified: true, referralCode: true, second_referralCode: true,
      createdAt: true, lastLoginAt: true,
      _count: { select: { bets: true, transactions: true } },
    },
  });
  if (!agent) throw new ApiError(404, 'Agent not found');
  if (agent.role !== 'AGENT') throw new ApiError(400, 'This account is not an agent');
  return { ...agent, stats: buildAgentStats(await listReferredUsers(agentId)) };
};

// ============================================
// ADMIN: staff activity log (who did what)
// ============================================

export const listAdminActions = async (filters: Record<string, unknown> = {}) => {
  const where: Record<string, unknown> = {};
  if (filters.userId && typeof filters.userId === 'string') where.userId = filters.userId;
  if (filters.action && typeof filters.action === 'string') where.action = { contains: filters.action };
  if (filters.search && typeof filters.search === 'string' && filters.search.trim()) {
    const s = filters.search.trim();
    where.OR = [
      { action: { contains: s } },
      { targetType: { contains: s } },
      { targetId: { contains: s } },
      { user: { email: { contains: s } } },
      { user: { name: { contains: s } } },
    ];
  }
  const page = Math.max(1, parseInt(String(filters.page ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(filters.limit ?? '20'), 10) || 20));
  const [total, data] = await Promise.all([
    prisma.adminActionLog.count({ where: where as never }),
    prisma.adminActionLog.findMany({
      where: where as never,
      include: { user: { select: { id: true, email: true, name: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  return { data, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
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
