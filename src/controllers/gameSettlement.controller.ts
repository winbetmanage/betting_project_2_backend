import * as settlementService from '../services/gameSettlement.service';
import asyncHandler from '../utils/asyncHandler';
import ApiError from '../utils/ApiError';

export const listBetGames = asyncHandler(async (_req, res) => {
  const data = await settlementService.listBetGames();
  res.json({ data });
});

export const getSettlement = asyncHandler(async (req, res) => {
  const data = await settlementService.getSettlement(req.params.id as string);
  res.json({ data });
});

export const settle = asyncHandler(async (req, res) => {
  const data = await settlementService.settleGame(req.params.id as string, req.user?.id);
  res.json({ message: 'Game settled', data });
});

export const payout = asyncHandler(async (req, res) => {
  const status = (req.body as { payoutStatus?: unknown }).payoutStatus;
  if (status !== 'PAID' && status !== 'SUBMITTED' && status !== 'PENDING') {
    throw new ApiError(400, "payoutStatus must be 'PAID', 'SUBMITTED' or 'PENDING'");
  }
  const data = await settlementService.markPayout(req.params.id as string, status, req.user?.id);
  res.json({ message: `Payout marked ${status}`, data });
});

export const footballDetails = asyncHandler(async (req, res) => {
  const data = await settlementService.getFootballGameDetails(req.params.id as string);
  res.json({ data });
});

export const calculate = asyncHandler(async (req, res) => {
  const data = await settlementService.calculateGameSettlement(req.params.id as string);
  const m = data.meta;
  res.json({
    message: m.resultFinished
      ? `Calculated — ${m.marketsResolved} market(s) resolved, ${m.selectionsUpdated} selection(s) updated`
      : "Calculated — game is not finished, nothing to mark",
    data,
  });
});

export const settleSingleBet = asyncHandler(async (req, res) => {
  const gameId = req.params.id as string;
  const betId = req.params.betId as string;
  const data = await settlementService.settleSingleBet(gameId, betId, req.user?.id);
  res.json({ message: 'Bet settled', data });
});
