const walletService = require('../services/wallet.service');
const asyncHandler = require('../utils/asyncHandler');

const getBalance = asyncHandler(async (req, res) => {
  const data = await walletService.getBalance(req.user.id);
  res.json({ data });
});

const getTransactions = asyncHandler(async (req, res) => {
  const transactions = await walletService.getTransactions(req.user.id, req.query);
  res.json({ data: transactions });
});

const deposit = asyncHandler(async (req, res) => {
  const data = await walletService.deposit(req.user.id, req.body.amount);
  res.json({ message: 'Deposit successful', data });
});

const withdraw = asyncHandler(async (req, res) => {
  const data = await walletService.withdraw(req.user.id, req.body.amount);
  res.json({ message: 'Withdrawal successful', data });
});

module.exports = { getBalance, getTransactions, deposit, withdraw };
