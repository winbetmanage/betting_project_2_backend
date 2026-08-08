const authService = require('../services/auth.service');
const asyncHandler = require('../utils/asyncHandler');

const register = asyncHandler(async (req, res) => {
  const data = await authService.register(req.body);
  res.status(201).json({ message: 'User registered successfully', data });
});

const login = asyncHandler(async (req, res) => {
  const data = await authService.login(req.body);
  res.json({ message: 'Login successful', data });
});

const refresh = asyncHandler(async (req, res) => {
  const data = await authService.refresh(req.body.refreshToken);
  res.json({ message: 'Tokens refreshed', data });
});

const logout = asyncHandler(async (req, res) => {
  const data = await authService.logout(req.body.refreshToken);
  res.json(data);
});

const logoutAll = asyncHandler(async (req, res) => {
  const data = await authService.logoutAll(req.user.id);
  res.json(data);
});

module.exports = { register, login, refresh, logout, logoutAll };
