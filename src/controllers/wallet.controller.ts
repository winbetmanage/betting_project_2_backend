import * as walletService from '../services/wallet.service';
import asyncHandler from '../utils/asyncHandler';

export const getBalance = asyncHandler(async (req, res) => {
  const data = await walletService.getBalance(req.user!.id);
  res.json({ data });
});

export const getTransactions = asyncHandler(async (req, res) => {
  const transactions = await walletService.getTransactions(req.user!.id, req.query as Record<string, unknown>);
  res.json({ data: transactions });
});

export const deposit = asyncHandler(async (req, res) => {
  const data = await walletService.deposit(req.user!.id, (req.body as { amount: number }).amount);
  res.json({ message: 'Deposit successful', data });
});

export const withdraw = asyncHandler(async (req, res) => {
  const data = await walletService.withdraw(req.user!.id, (req.body as { amount: number }).amount);
  res.json({ message: 'Withdrawal successful', data });
});
