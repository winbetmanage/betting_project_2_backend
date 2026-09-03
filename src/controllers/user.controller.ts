import * as userService from '../services/user.service';
import asyncHandler from '../utils/asyncHandler';
import { sanitizeUser } from '../utils/sanitize';

export const getProfile = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.user!.id);
  res.json({ data: sanitizeUser(user) });
});

export const updateProfile = asyncHandler(async (req, res) => {
  const user = await userService.updateUser(req.user!.id, req.body as Record<string, unknown>);
  res.json({ message: 'Profile updated', data: sanitizeUser(user) });
});

export const list = asyncHandler(async (req, res) => {
  const result = await userService.listUsers(req.query as Record<string, unknown>);
  res.json({ data: result.data, total: result.total, page: result.page, limit: result.limit, totalPages: result.totalPages });
});

export const getById = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.params.id as string);
  res.json({ data: sanitizeUser(user) });
});

export const updateByAdmin = asyncHandler(async (req, res) => {
  if (req.params.id === req.user!.id && req.body.role && req.body.role !== req.user!.role) {
    // Allow but warn? For now allow, but prevent self-demotion to avoid lockout? We'll allow with check
  }
  const user = await userService.updateUserByAdmin(req.params.id as string, req.body as Record<string, unknown>);
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
