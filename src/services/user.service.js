const prisma = require('../utils/prisma');
const ApiError = require('../utils/ApiError');

const getUserById = async (id) => {
  const user = await prisma.user.findUnique({
    where: { id },
    include: { _count: { select: { bets: true, transactions: true } } },
  });
  if (!user) throw new ApiError(404, 'User not found');
  return user;
};

const updateUser = async (id, updates) => {
  const allowedFields = ['name'];
  const data = {};
  for (const field of allowedFields) {
    if (updates[field] !== undefined) data[field] = updates[field];
  }
  if (Object.keys(data).length === 0) throw new ApiError(400, 'No valid fields to update');

  const user = await prisma.user.update({ where: { id }, data });
  return user;
};

module.exports = { getUserById, updateUser };
