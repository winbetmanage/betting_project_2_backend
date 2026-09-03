import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import type { Prisma } from '@prisma/client';

const roundMoney = (value: number | Prisma.Decimal): number => Math.round(Number(value) * 100) / 100;

export const getBalance = async (userId: string) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { balance: true, heldBalance: true } });
  if (!user) throw new ApiError(404, 'User not found');
  const balance = Number(user.balance);
  const held = Number(user.heldBalance ?? 0);
  return { balance, heldBalance: held, available: balance - held };
};

export const getTransactions = async (userId: string, filters: Record<string, unknown> = {}) => {
  const where: Prisma.TransactionWhereInput = { userId };
  if (filters.type && typeof filters.type === 'string') where.type = filters.type as never;
  return prisma.transaction.findMany({ where, orderBy: { createdAt: 'desc' } });
};

export const deposit = async (userId: string, amount: number | string) => {
  if (amount === undefined || Number(amount) <= 0) throw new ApiError(400, 'Deposit amount must be positive');
  const depositAmount = roundMoney(Number(amount));

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new ApiError(404, 'User not found');
    const balanceAfter = roundMoney(Number(user.balance) + depositAmount);
    await tx.user.update({ where: { id: userId }, data: { balance: { increment: depositAmount } } });
    await tx.transaction.create({
      data: { userId, type: 'DEPOSIT', amount: depositAmount, balanceAfter },
    });
    return { balance: balanceAfter };
  });
};

export const withdraw = async (userId: string, amount: number | string) => {
  if (amount === undefined || Number(amount) <= 0) throw new ApiError(400, 'Withdrawal amount must be positive');
  const withdrawAmount = roundMoney(Number(amount));

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new ApiError(404, 'User not found');
    if (Number(user.balance) < withdrawAmount) throw new ApiError(400, 'Insufficient balance');
    const balanceAfter = roundMoney(Number(user.balance) - withdrawAmount);
    await tx.user.update({ where: { id: userId }, data: { balance: { decrement: withdrawAmount } } });
    await tx.transaction.create({
      data: { userId, type: 'WITHDRAWAL', amount: withdrawAmount, balanceAfter },
    });
    return { balance: balanceAfter };
  });
};
