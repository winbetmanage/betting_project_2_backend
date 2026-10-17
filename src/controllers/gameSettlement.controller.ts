import * as settlementService from '../services/gameSettlement.service';
import asyncHandler from '../utils/asyncHandler';
import ApiError from '../utils/ApiError';

export const listBetGames = asyncHandler(async (req, res) => {
  const finishedOnly = (req.query as { finished?: unknown }).finished === 'true';
  const data = await settlementService.listBetGames(finishedOnly);
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

export const settlePayments = asyncHandler(async (req, res) => {
  const data = await settlementService.settleGamePayments(req.params.id as string, req.user?.id);
  const n = (data.meta as { notified?: number }).notified ?? 0;
  res.json({ message: `Winners paid${n > 0 ? ` — ${n} winner${n === 1 ? "" : "s"} notified` : ""}`, data });
});

export const submitPayments = asyncHandler(async (req, res) => {
  const rawIds = (req.body as { betIds?: unknown }).betIds;
  const betIds = Array.isArray(rawIds) ? rawIds.filter((v): v is string => typeof v === 'string' && v.length > 0) : undefined;
  if (rawIds !== undefined && betIds?.length === 0) {
    throw new ApiError(400, 'betIds must be a non-empty array of ticket ids');
  }
  const data = await settlementService.submitPendingPayments(req.params.id as string, req.user?.id, betIds);
  const m = data.meta as { submitted?: number; paidCount?: number; paidTotal?: number; lostCount?: number; skipped?: { betId: string; reason: string }[] };
  res.json({
    message: `Submitted ${m.submitted ?? 0} ticket(s) — paid ${m.paidCount ?? 0} winner(s) ETB ${Number(m.paidTotal ?? 0).toFixed(2)}${(m.lostCount ?? 0) > 0 ? `, ${m.lostCount} marked lost` : ""}${(m.skipped?.length ?? 0) > 0 ? `, ${m.skipped!.length} skipped` : ""}`,
    data,
  });
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
  const data = await settlementService.calculateGameSettlement(req.params.id as string, req.user?.id);
  const m = data.meta as {
    resultFinished: boolean; legsGraded: number; betsMarkedLost: number; lostTicketsTouched: number; profit: number;
  };
  res.json({
    message: `Graded ${m.legsGraded} leg(s)${(m.lostTicketsTouched ?? 0) > 0 ? ` (incl. legs on ${m.lostTicketsTouched} already-lost ticket(s))` : ""}, marked ${m.betsMarkedLost} ticket(s) as lost. Projected profit ETB ${m.profit.toLocaleString("en-US", { minimumFractionDigits: 2 })}. Nothing was paid out.`,
    data,
  });
});

export const settleSingleBet = asyncHandler(async (req, res) => {
  const gameId = req.params.id as string;
  const betId = req.params.betId as string;
  const data = await settlementService.settleSingleBet(gameId, betId, req.user?.id);
  res.json({ message: 'Bet settled', data });
});
