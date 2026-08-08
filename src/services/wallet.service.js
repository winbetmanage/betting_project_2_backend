const prisma = require('../utils/prisma');
const ApiError = require('../utils/ApiError');

const roundMoney = (value) => Math.round(value * 100) / 100;

const getBalance = async (userId) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { balance: true } });
  if (!user) throw new ApiError(404, 'User not found');
  return { balance: user.balance };
};

const getTransactions = async (userId, filters = {}) => {
  const where = { userId };
  if (filters.type) where.type = filters.type;
  return prisma.transaction.findMany({ where, orderBy: { createdAt: 'desc' } });
};

const deposit = async (userId, amount) => {
  if (amount === undefined || Number(amount) <= 0) throw new ApiError(400, 'Deposit amount must be positive');
  const depositAmount = roundMoney(Number(amount));

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new ApiError(404, 'User not found');
    const balanceAfter = roundMoney(user.balance + depositAmount);
    await tx.user.update({ where: { id: userId }, data: { balance: { increment: depositAmount } } });
    await tx.transaction.create({
      data: { userId, type: 'DEPOSIT', amount: depositAmount, balanceAfter },
    });
    return { balance: balanceAfter };
  });
};

const withdraw = async (userId, amount) => {
  if (amount === undefined || Number(amount) <= 0) throw new ApiError(400, 'Withdrawal amount must be positive');
  const withdrawAmount = roundMoney(Number(amount));

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new ApiError(404, 'User not found');
    if (user.balance < withdrawAmount) throw new ApiError(400, 'Insufficient balance');
    const balanceAfter = roundMoney(user.balance - withdrawAmount);
    await tx.user.update({ where: { id: userId }, data: { balance: { decrement: withdrawAmount } } });
    await tx.transaction.create({
      data: { userId, type: 'WITHDRAWAL', amount: withdrawAmount, balanceAfter },
    });
    return { balance: balanceAfter };
  });
};

module.exports = { getBalance, getTransactions, deposit, withdraw };
