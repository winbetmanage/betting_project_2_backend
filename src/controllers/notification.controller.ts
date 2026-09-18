import * as notificationService from '../services/notification.service';
import asyncHandler from '../utils/asyncHandler';
import ApiError from '../utils/ApiError';

export const mine = asyncHandler(async (req, res) => {
  const data = await notificationService.listUserNotifications(req.user!.id, {
    unreadOnly: req.query.unreadOnly === 'true' || req.query.unreadOnly === '1',
    limit: Number(req.query.limit) || undefined,
  });
  res.json({ data });
});

export const adminFeed = asyncHandler(async (_req, res) => {
  const data = await notificationService.listAdminNotifications({
    unreadOnly: _req.query.unreadOnly === 'true' || _req.query.unreadOnly === '1',
    limit: Number(_req.query.limit) || undefined,
  });
  res.json({ data });
});

export const unreadCount = asyncHandler(async (req, res) => {
  const isAdmin = req.user!.role === 'ADMIN' || req.user!.role === 'ODDS_MANAGER';
  const data = await notificationService.unreadCounts(req.user!.id, isAdmin);
  res.json({ data });
});

export const markOneRead = asyncHandler(async (req, res) => {
  const isAdmin = req.user!.role === 'ADMIN' || req.user!.role === 'ODDS_MANAGER';
  const data = await notificationService.markRead(req.params.id as string, { userId: req.user!.id, admin: isAdmin });
  if (!data) throw new ApiError(404, 'Notification not found');
  res.json({ data });
});

export const markAll = asyncHandler(async (req, res) => {
  const isAdmin = req.user!.role === 'ADMIN' || req.user!.role === 'ODDS_MANAGER';
  const adminOnly = (req.body as { scope?: unknown }).scope === 'admin';
  const data = await notificationService.markAllRead({ userId: req.user!.id, admin: isAdmin, adminOnly });
  res.json({ data });
});
