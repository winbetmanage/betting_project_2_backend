import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import * as betService from './bet.service';

export const createMarket = async (gameId: string, data: Record<string, unknown>) => {
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) throw new ApiError(404, 'Game not found');
  return prisma.market.create({ data: { ...(data as object), gameId } as never, include: { selections: true } });
};

export const listMarkets = async (gameId: string) => {
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) throw new ApiError(404, 'Game not found');
  return prisma.market.findMany({ where: { gameId }, include: { selections: true } });
};

export const getMarketById = async (id: string) => {
  const market = await prisma.market.findUnique({
    where: { id },
    include: { selections: true, game: true },
  });
  if (!market) throw new ApiError(404, 'Market not found');
  return market;
};

export const updateMarket = async (id: string, data: Record<string, unknown>, actorId: string) => {
  const { lastActionById: _ignoredBy, lastActionAt: _ignoredAt, ...rest } = data;
  return prisma.market.update({
    where: { id },
    data: { ...(rest as Record<string, unknown>), lastActionById: actorId, lastActionAt: new Date() } as never,
    include: { selections: true },
  });
};

export const addSelection = async (marketId: string, data: Record<string, unknown>) => {
  const market = await prisma.market.findUnique({ where: { id: marketId } });
  if (!market) throw new ApiError(404, 'Market not found');
  return prisma.selection.create({ data: { ...(data as object), marketId } as never });
};

export const updateSelection = async (id: string, data: Record<string, unknown>) => {
  return prisma.selection.update({ where: { id }, data: data as never });
};

export const updateOdds = async (id: string, odds: number) => {
  if (odds <= 0) throw new ApiError(400, 'Odds must be positive');
  const selection = await prisma.selection.update({
    where: { id },
    data: { odds },
    include: { market: true },
  });
  await prisma.oddsHistory.create({ data: { selectionId: id, odds } });
  return selection;
};

export const removeMarket = async (id: string) => {
  const market = await prisma.market.findUnique({
    where: { id },
    include: { selections: { include: { betSelections: true } } },
  });
  if (!market) throw new ApiError(404, 'Market not found');
  const hasBets = market.selections.some((s) => s.betSelections.length > 0);
  if (hasBets) throw new ApiError(400, 'Cannot remove market with active bets');

  return prisma.$transaction(async (tx) => {
    const selectionIds = market.selections.map((s) => s.id);
    await tx.oddsHistory.deleteMany({ where: { selectionId: { in: selectionIds } } });
    await tx.selection.deleteMany({ where: { id: { in: selectionIds } } });
    await tx.market.delete({ where: { id } });
    return { message: 'Market removed' };
  });
};

export const settleSelection = async (id: string, isWinning: boolean | null) => {
  return prisma.$transaction(async (tx) => {
    const selection = await tx.selection.findUnique({
      where: { id },
      include: { market: true },
    });
    if (!selection) throw new ApiError(404, 'Selection not found');
    if (selection.market.status === 'SETTLED') throw new ApiError(400, 'Market already settled');
    if (isWinning !== null && selection.isWinning !== null && selection.isWinning !== isWinning) {
      throw new ApiError(400, 'Selection already settled with a different result');
    }

    if (isWinning !== null) {
      await tx.selection.update({ where: { id }, data: { isWinning } });
    }

    // Update this selection's pending legs, then let the shared grader decide the
    // whole ticket (parlay-aware: any LOST -> LOST; VOID legs drop out of the odds
    // product; credit + ledger row happen inside THIS transaction).
    const openBetSelections = await tx.betSelection.findMany({
      where: { selectionId: id, result: 'PENDING' },
      select: { id: true, betId: true },
    });
    for (const bs of openBetSelections) {
      const result = isWinning === null ? 'VOID' : isWinning ? 'WON' : 'LOST';
      await tx.betSelection.update({ where: { id: bs.id }, data: { result } });
      await betService.gradeBetIfComplete(tx, bs.betId);
    }

    if (isWinning === null) {
      const pending = await tx.betSelection.count({ where: { selection: { marketId: selection.marketId }, result: 'PENDING' } });
      if (pending === 0) await tx.market.update({ where: { id: selection.marketId }, data: { status: 'SETTLED' } });
      return { id, isWinning: null };
    }

    const allSelections = await tx.selection.findMany({ where: { marketId: selection.marketId } });
    if (allSelections.every((s) => s.isWinning !== null)) {
      await tx.market.update({ where: { id: selection.marketId }, data: { status: 'SETTLED' } });
    }

    return { id, isWinning };
  }, { timeout: 20000, maxWait: 10000 });
};
