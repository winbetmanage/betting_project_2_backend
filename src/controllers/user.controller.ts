import * as userService from '../services/user.service';
import asyncHandler from '../utils/asyncHandler';
import { sanitizeUser } from '../utils/sanitize';
import ApiError from '../utils/ApiError';
import { isSubAdminRole } from '../constants/roles';

export const getProfile = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.user!.id);
  res.json({ data: sanitizeUser(user) });
});

export const updateProfile = asyncHandler(async (req, res) => {
  const user = await userService.updateUser(req.user!.id, req.body as Record<string, unknown>);
  res.json({ message: 'Profile updated', data: sanitizeUser(user) });
});

export const listMyReferrals = asyncHandler(async (req, res) => {
  const data = await userService.listMyReferrals(req.user!.id);
  res.json({ data });
});

export const listAdminActions = asyncHandler(async (req, res) => {
  const result = await userService.listAdminActions(req.query as Record<string, unknown>);
  res.json({ data: result.data, total: result.total, page: result.page, limit: result.limit, totalPages: result.totalPages });
});

/**
 * Sub-admins may only read players and agents. Centralised so every
 * people-related endpoint enforces the same boundary.
 */
const assertVisibleToCaller = async (id: string, callerRole: string) => {
  if (!isSubAdminRole(callerRole)) return;
  const target = await userService.getUserById(id);
  if (userService.isStaffRole(target.role)) throw new ApiError(403, 'Not allowed to view this account');
};

export const listUserBets = asyncHandler(async (req, res) => {
  await assertVisibleToCaller(req.params.id as string, req.user!.role);
  const data = await userService.listUserBets(req.params.id as string);
  res.json({ data });
});

export const getUpline = asyncHandler(async (req, res) => {
  await assertVisibleToCaller(req.params.id as string, req.user!.role);
  const data = await userService.getUserUpline(req.params.id as string);
  res.json({ data });
});

export const listReferredUsers = asyncHandler(async (req, res) => {
  await assertVisibleToCaller(req.params.id as string, req.user!.role);
  const data = await userService.listReferredUsers(req.params.id as string);
  res.json({ data });
});

export const listAgentsOverview = asyncHandler(async (_req, res) => {
  const data = await userService.listAgentsOverview();
  res.json({ data });
});

export const list = asyncHandler(async (req, res) => {
  const filters = { ...(req.query as Record<string, unknown>) };
  // Sub-admins are scoped to players and agents: staff accounts are filtered out
  // server-side so they can never appear in a people list.
  if (isSubAdminRole(req.user!.role)) {
    filters.nonStaffOnly = 'true';
    if (typeof filters.role === 'string' && userService.isStaffRole(filters.role)) delete filters.role;
  }
  const result = await userService.listUsers(filters);
  res.json({ data: result.data, total: result.total, page: result.page, limit: result.limit, totalPages: result.totalPages });
});

export const getById = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.params.id as string);
  // Sub-admins get read-only oversight of players and agents only.
  if (isSubAdminRole(req.user!.role) && userService.isStaffRole(user.role)) {
    throw new ApiError(403, 'Not allowed to view this account');
  }
  res.json({ data: sanitizeUser(user) });
});

export const getAgentStats = asyncHandler(async (req, res) => {
  const data = await userService.getAgentStats(req.params.id as string);
  res.json({ data });
});

export const updateByAdmin = asyncHandler(async (req, res) => {
  // Sub-admins may only flip an account between USER and AGENT — no balances,
  // no activation flags, no codes, no staff accounts, never themselves.
  if (isSubAdminRole(req.user!.role)) {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const keys = Object.keys(body);
    if (keys.length !== 1 || body.role === undefined) {
      throw new ApiError(403, 'Sub-admins may only switch an account between USER and AGENT');
    }
    const user = await userService.switchRoleBySubAdmin(req.params.id as string, body.role, req.user!.id);
    res.json({ message: 'Account type updated', data: sanitizeUser(user) });
    return;
  }
  if (req.params.id === req.user!.id && req.body.role && req.body.role !== req.user!.role) {
    // Allow but warn? For now allow, but prevent self-demotion to avoid lockout? We'll allow with check
  }
  const user = await userService.updateUserByAdmin(req.params.id as string, req.body as Record<string, unknown>, req.user!.id);
  res.json({ message: 'User updated', data: sanitizeUser(user) });
});

export const remove = asyncHandler(async (req, res) => {
  if (req.params.id === req.user!.id) {
    res.status(400).json({ message: 'Cannot delete your own account' });
    return;
  }
  const result = await userService.deleteUser(req.params.id as string);
  res.json({ message: result.message, data: result });
});

export const listDevices = asyncHandler(async (req, res) => {
  const devices = await userService.listAllDevices(req.query as Record<string, unknown>);
  res.json({ data: devices });
});

export const listReferralBonuses = asyncHandler(async (_req, res) => {
  const data = await userService.listReferralBonuses();
  res.json({ data });
});
