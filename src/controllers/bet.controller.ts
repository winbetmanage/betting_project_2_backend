import * as betService from '../services/bet.service';
import asyncHandler from '../utils/asyncHandler';

export const place = asyncHandler(async (req, res) => {
  const bet = await betService.placeBet(req.user!.id, req.body);
  res.status(201).json({ message: 'Bet placed', data: bet });
});

export const myBets = asyncHandler(async (req, res) => {
  const bets = await betService.getUserBets(req.user!.id, req.query as Record<string, unknown>);
  res.json({ data: bets });
});

export const getById = asyncHandler(async (req, res) => {
  const isAdmin = req.user!.role === 'ADMIN';
  const bet = await betService.getBetById(req.params.id as string, req.user!.id, isAdmin);
  res.json({ data: bet });
});

export const allBets = asyncHandler(async (req, res) => {
  const bets = await betService.getAllBets(req.query as Record<string, unknown>);
  res.json({ data: bets });
});
