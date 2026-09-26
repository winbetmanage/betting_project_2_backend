import * as authService from '../services/auth.service';
import asyncHandler from '../utils/asyncHandler';
import type { Request } from 'express';

const requestMeta = (req: Request) => {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (typeof fwd === 'string' ? fwd.split(',')[0].trim() : Array.isArray(fwd) ? fwd[0] : undefined)
    || req.headers['x-real-ip'] as string | undefined
    || req.ip
    || req.socket.remoteAddress
    || 'unknown';
  return { ip, userAgent: req.headers['user-agent'] };
};

export const register = asyncHandler(async (req, res) => {
  const ref = typeof req.query.ref === 'string' ? req.query.ref : undefined;
  const body = req.body as { referralCode?: string; secondReferralCode?: string };
  const data = await authService.register(
    { ...(req.body as object), referralCode: ref ?? body.referralCode, secondReferralCode: body.secondReferralCode } as never,
    requestMeta(req)
  );
  res.status(201).json({ message: 'User registered successfully', data });
});

export const referralInfo = asyncHandler(async (req, res) => {
  const code = typeof req.query.ref === 'string' ? req.query.ref : '';
  const data = await authService.getReferralInfo(code);
  res.json({ data });
});

export const login = asyncHandler(async (req, res) => {
  const data = await authService.login(req.body, requestMeta(req));
  res.json({ message: 'Login successful', data });
});

export const refresh = asyncHandler(async (req, res) => {
  const data = await authService.refresh(req.body.refreshToken as string, requestMeta(req));
  res.json({ message: 'Tokens refreshed', data });
});

export const logout = asyncHandler(async (req, res) => {
  const data = await authService.logout(req.body.refreshToken as string);
  res.json(data);
});

export const logoutAll = asyncHandler(async (req, res) => {
  const data = await authService.logoutAll(req.user!.id);
  res.json(data);
});

export const changePassword = asyncHandler(async (req, res) => {
  const data = await authService.changePassword(req.user!.id, req.body.currentPassword as string, req.body.newPassword as string);
  res.json(data);
});
