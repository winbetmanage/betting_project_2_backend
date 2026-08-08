const userService = require('../services/user.service');
const asyncHandler = require('../utils/asyncHandler');
const { sanitizeUser } = require('../utils/sanitize');

const getProfile = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.user.id);
  res.json({ data: sanitizeUser(user) });
});

const updateProfile = asyncHandler(async (req, res) => {
  const user = await userService.updateUser(req.user.id, req.body);
  res.json({ message: 'Profile updated', data: sanitizeUser(user) });
});

module.exports = { getProfile, updateProfile };
