import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import { recomputeBet } from './bet.service';

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

export const updateMarket = async (id: string, data: Record<string, unknown>) => {
  return prisma.market.update({ where: { id }, data: data as never, include: { selections: true } });
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

export const settleSelection = async (id: string, isWinning: boolean) => {
  return prisma.$transaction(async (tx) => {
    const selection = await tx.selection.findUnique({
      where: { id },
      include: { market: true },
    });
    if (!selection) throw new ApiError(404, 'Selection not found');
    if (selection.market.status === 'SETTLED') throw new ApiError(400, 'Market already settled');
    if (selection.isWinning !== null && selection.isWinning !== isWinning) {
      throw new ApiError(400, 'Selection already settled with a different result');
    }

    await tx.selection.update({ where: { id }, data: { isWinning } });

    const openBetSelections = await tx.betSelection.findMany({
      where: { selectionId: id, result: 'PENDING' },
      select: { id: true, betId: true },
    });

    for (const bs of openBetSelections) {
      await tx.betSelection.update({ where: { id: bs.id }, data: { result: isWinning ? 'WON' : 'LOST' } });
      // recomputeBet uses prisma directly - run inline logic within same transaction context for atomicity
      const bet = await tx.bet.findUnique({ where: { id: bs.betId }, include: { selections: true } });
      if (!bet || bet.status !== 'PENDING') continue;
      const legs = bet.selections;
      if (legs.some((l) => l.result === 'LOST')) {
        await tx.bet.update({ where: { id: bs.betId }, data: { status: 'LOST', settledAt: new Date() } });
        continue;
      }
      if (legs.some((l) => l.result === 'PENDING')) continue;
      const voided = legs.filter((l) => l.result === 'VOID');
      if (voided.length === legs.length) {
        const user = await tx.user.findUnique({ where: { id: bet.userId } });
        if (user) {
          const balanceAfter = Math.round((Number(user.balance) + Number(bet.stake)) * 100) / 100;
          await tx.user.update({ where: { id: bet.userId }, data: { balance: { increment: bet.stake } } });
          await tx.transaction.create({ data: { userId: bet.userId, type: 'BET_REFUND', amount: bet.stake, balanceAfter, reference: bet.id } });
        }
        await tx.bet.update({ where: { id: bs.betId }, data: { status: 'VOID', settledAt: new Date() } });
        continue;
      }
      const activeOdds = legs.filter((l) => l.result === 'WON').reduce((acc, l) => acc * Number(l.oddsAtPlacement), 1);
      const payout = Math.round(Number(bet.stake) * (activeOdds || 1) * 100) / 100;
      const user = await tx.user.findUnique({ where: { id: bet.userId } });
      if (user) {
        const balanceAfter = Math.round((Number(user.balance) + payout) * 100) / 100;
        await tx.user.update({ where: { id: bet.userId }, data: { balance: { increment: payout } } });
        await tx.transaction.create({ data: { userId: bet.userId, type: 'BET_WON', amount: payout, balanceAfter, reference: bet.id } });
      }
      await tx.bet.update({ where: { id: bs.betId }, data: { status: 'WON', settledAt: new Date() } });
    }

    const allSelections = await tx.selection.findMany({ where: { marketId: selection.marketId } });
    if (allSelections.every((s) => s.isWinning !== null)) {
      await tx.market.update({ where: { id: selection.marketId }, data: { status: 'SETTLED' } });
    }

    return { id, isWinning };
  });
};
