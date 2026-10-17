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
    include: { selections: { include: { betSelections: { include: { bet: { select: { id: true, status: true } } } } } } },
  });
  if (!market) throw new ApiError(404, 'Market not found');
  const legs = market.selections.flatMap((s) => s.betSelections);
  if (legs.length > 0) {
    const betIds = [...new Set(legs.map((l) => l.betId))];
    const settled = [...new Set(legs.filter((l) => l.bet.status !== 'PENDING').map((l) => l.bet.status))];
    throw new ApiError(
      400,
      `Cannot remove this market: ${betIds.length} ticket(s) already hold a leg on it${settled.length ? ` (${settled.join(', ')})` : ''}. Use the Replace action instead — it moves those bets onto a correct market.`
    );
  }

  return prisma.$transaction(async (tx) => {
    const selectionIds = market.selections.map((s) => s.id);
    await tx.oddsHistory.deleteMany({ where: { selectionId: { in: selectionIds } } });
    await tx.selection.deleteMany({ where: { id: { in: selectionIds } } });
    await tx.market.delete({ where: { id } });
    return { message: 'Market removed' };
  });
};

/**
 * Hide a market from the players' betting list without touching anybody's bet.
 *
 * SUSPENDED is the status that does exactly this, and both ends of the flow
 * already honour it: the players' game page renders only OPEN markets
 * (games/[id]/page.tsx filters m.status === 'OPEN'), and placeBet requires
 * `market: { status: 'OPEN' }`. So a suspended market stops accepting new bets
 * and disappears from the list, while every existing BetSelection still points
 * at it — settlement only skips SETTLED markets, so those bets grade normally.
 *
 * The market is never deleted or voided, so this is fully reversible.
 */
export const setMarketHidden = async (id: string, hidden: boolean, actorId: string) => {
  const market = await prisma.market.findUnique({ where: { id } });
  if (!market) throw new ApiError(404, 'Market not found');
  if (market.status === 'SETTLED') throw new ApiError(400, 'Settled markets cannot be hidden — their results are already graded');
  if (market.status === 'CANCELLED') {
    throw new ApiError(400, 'This market was retired by a replacement — it is already out of the betting list and cannot be reopened');
  }

  const nextStatus = hidden ? 'SUSPENDED' : 'OPEN';
  if (market.status === nextStatus) {
    return { id, status: nextStatus, changed: false, betCount: 0, bettorCount: 0 };
  }

  // Existing bets must survive untouched, so count them for the log + the toast.
  const legs = await prisma.betSelection.findMany({
    where: { selection: { marketId: id } },
    select: { betId: true, bet: { select: { userId: true } } },
  });
  const betIds = new Set(legs.map((l) => l.betId));
  const bettors = new Set(legs.map((l) => l.bet.userId));

  const updated = await prisma.market.update({
    where: { id },
    data: { status: nextStatus, lastActionById: actorId, lastActionAt: new Date() },
    include: { selections: true },
  });

  await prisma.adminActionLog.create({
    data: {
      userId: actorId,
      action: hidden ? 'MARKET_HIDDEN' : 'MARKET_SHOWN',
      targetType: 'Market',
      targetId: id,
      metadata: {
        marketName: market.name,
        marketKey: (market.parameters as { marketKey?: string } | null)?.marketKey ?? null,
        line: (market.parameters as { line?: number | null } | null)?.line ?? null,
        fromStatus: market.status,
        toStatus: nextStatus,
        selectionCount: updated.selections.length,
        // Proof that nothing already placed was disturbed.
        betsKept: betIds.size,
        bettorsKept: bettors.size,
      },
    },
  });

  return { id, status: nextStatus, changed: true, betCount: betIds.size, bettorCount: bettors.size };
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

    // Re-grade EVERY ticket holding this selection — not only ones with open legs.
    // Legs graded earlier via Calculate (which writes leg results without grading)
    // would otherwise leave their tickets stuck PENDING forever with no payout.
    // gradeBetIfComplete is a safe no-op for settled tickets or tickets still
    // waiting on other games' legs.
    const linkedBetIds = await tx.betSelection.findMany({
      where: { selectionId: id },
      select: { betId: true },
    });
    const alreadyGraded = new Set(openBetSelections.map((b) => b.betId));
    for (const { betId } of linkedBetIds) {
      if (alreadyGraded.has(betId)) continue;
      await betService.gradeBetIfComplete(tx, betId);
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
