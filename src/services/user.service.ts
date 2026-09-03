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
  // keep backward compat for old 'name' only updates via /me
  const hasTheme = allowed.themeColor !== undefined || allowed.themeMode !== undefined;
  const hasName = updates.name !== undefined;
  if (!hasTheme && !hasName) {
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

export const updateUserByAdmin = async (id: string, updates: Record<string, unknown>) => {
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

  const user = await prisma.user.update({ where: { id }, data: allowed });
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
