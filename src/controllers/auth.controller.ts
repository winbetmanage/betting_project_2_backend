import * as authService from '../services/auth.service';
import asyncHandler from '../utils/asyncHandler';

export const register = asyncHandler(async (req, res) => {
  const data = await authService.register(req.body);
  res.status(201).json({ message: 'User registered successfully', data });
});

export const login = asyncHandler(async (req, res) => {
  const data = await authService.login(req.body);
  res.json({ message: 'Login successful', data });
});

export const refresh = asyncHandler(async (req, res) => {
  const data = await authService.refresh(req.body.refreshToken as string);
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
