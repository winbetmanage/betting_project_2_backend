import * as transferAccountService from '../services/transferAccount.service';
import asyncHandler from '../utils/asyncHandler';

export const list = asyncHandler(async (_req, res) => {
  const accounts = await transferAccountService.listTransferAccounts();
  res.json({ data: accounts });
});

export const listActive = asyncHandler(async (_req, res) => {
  const accounts = await transferAccountService.listActiveTransferAccounts();
  res.json({ data: accounts });
});

export const getById = asyncHandler(async (req, res) => {
  const account = await transferAccountService.getTransferAccountById(req.params.id as string);
  res.json({ data: account });
});

export const create = asyncHandler(async (req, res) => {
  const account = await transferAccountService.createTransferAccount(req.body);
  res.status(201).json({ message: 'Transfer account created', data: account });
});

export const update = asyncHandler(async (req, res) => {
  const account = await transferAccountService.updateTransferAccount(req.params.id as string, req.body);
  res.json({ message: 'Transfer account updated', data: account });
});

export const remove = asyncHandler(async (req, res) => {
  await transferAccountService.deleteTransferAccount(req.params.id as string);
  res.json({ message: 'Transfer account deleted' });
});
