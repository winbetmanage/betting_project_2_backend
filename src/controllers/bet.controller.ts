import * as betService from '../services/bet.service';
import * as settlementService from '../services/gameSettlement.service';
import asyncHandler from '../utils/asyncHandler';
import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';

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

export const settleSingle = asyncHandler(async (req, res) => {
  const betId = req.params.id as string;
  const bet = await prisma.bet.findUnique({ where: { id: betId }, include: { selections: { include: { selection: { select: { market: { select: { gameId: true } } } } } } } });
  if (!bet) throw new ApiError(404, 'Bet not found');
  const gameId = bet.selections[0]?.selection?.market?.gameId;
  if (!gameId) throw new ApiError(400, 'Bet has no game');
  const data = await settlementService.settleSingleBet(gameId, betId, req.user?.id);
  res.json({ message: 'Bet settled', data });
});
