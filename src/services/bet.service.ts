import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import type { Prisma } from '@prisma/client';

const roundMoney = (value: number | Prisma.Decimal): number => Math.round(Number(value) * 100) / 100;
const roundOdds = (value: number): number => Math.round(value * 1000) / 1000;

export interface PlaceBetInput {
  type?: string;
  stake: number | string;
  selections: Array<{ selectionId: string; odds?: number }>;
}

export const placeBet = async (userId: string, { type = 'SINGLE', stake, selections }: PlaceBetInput) => {
  if (stake === undefined || Number(stake) <= 0) throw new ApiError(400, 'Stake must be positive');
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new ApiError(400, 'At least one selection is required');
  }
  const betType = (['SINGLE', 'MULTIPLE', 'SYSTEM'] as const).includes(type as never) ? type : 'SINGLE';
  const stakeAmount = roundMoney(Number(stake));

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError(404, 'User not found');
  if (!user.isActive) throw new ApiError(403, 'Account is inactive');

  const availableBalance = Number(user.balance) - Number((user as { heldBalance?: unknown }).heldBalance ?? 0);
  if (availableBalance < stakeAmount) throw new ApiError(400, 'Insufficient balance');

  const requestedIds = [...new Set(selections.map((s) => s.selectionId))];

  // Fetch selections with market status validation + also fetch current odds for stale-check
  const available = await prisma.selection.findMany({
    where: { id: { in: requestedIds }, market: { status: 'OPEN' } },
    include: { market: { select: { status: true, game: { select: { status: true, startTime: true } } } } },
  });
  if (available.length !== requestedIds.length) {
    throw new ApiError(400, 'One or more selections are unavailable or their market is not open');
  }

  // Game not started / odds stale validation
  for (const sel of available) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const game = (sel.market as any).game;
    if (game && game.status !== 'SCHEDULED') {
      throw new ApiError(400, `Market for selection ${sel.id} is no longer open for betting (game status: ${game.status})`);
    }
    if (game && new Date(game.startTime) <= new Date()) {
      throw new ApiError(400, `Game for selection ${sel.id} has already started`);
    }
  }

  // If client sent odds, verify they match current odds (stale odds protection)
  const clientOddsMap = new Map<string, number>();
  for (const s of selections) {
    if (s.odds !== undefined) clientOddsMap.set(s.selectionId, Number(s.odds));
  }
  if (clientOddsMap.size > 0) {
    for (const sel of available) {
      const expected = clientOddsMap.get(sel.id);
      if (expected !== undefined && Math.abs(Number(sel.odds) - expected) > 0.001) {
        throw new ApiError(409, `Odds changed for selection ${sel.id}. Current: ${sel.odds}, requested: ${expected}. Please refresh.`);
      }
    }
  }

  const byId = new Map(available.map((s) => [s.id, s]));
  const betSelections = requestedIds.map((id) => {
    const selection = byId.get(id)!;
    return { selectionId: id, oddsAtPlacement: selection.odds, result: 'PENDING' as const };
  });

  const totalOdds = roundOdds(betSelections.reduce((acc, s) => acc * Number(s.oddsAtPlacement), 1));
  const potentialPayout = roundMoney(stakeAmount * totalOdds);

  const bet = await prisma.$transaction(async (tx) => {
    const updatedUser = await tx.user.update({
      where: { id: userId },
      data: { balance: { decrement: stakeAmount } },
    });
    await tx.transaction.create({
      data: {
        userId,
        type: 'BET_PLACED',
        amount: stakeAmount,
        balanceAfter: roundMoney(Number(updatedUser.balance)),
        reference: 'bet',
      },
    });
    return tx.bet.create({
      data: {
        userId,
        type: betType as never,
        stake: stakeAmount,
        totalOdds,
        potentialPayout,
        status: 'PENDING',
        selections: { create: betSelections },
      },
      include: {
        selections: { include: { selection: { include: { market: true } } } },
      },
    });
  });

  return bet;
};

export const getUserBets = async (userId: string, filters: Record<string, unknown> = {}) => {
  const where: Prisma.BetWhereInput = { userId };
  if (filters.status && typeof filters.status === 'string') where.status = filters.status as never;
  return prisma.bet.findMany({
    where,
    include: {
      selections: {
        include: { selection: { include: { market: { include: { game: { include: { competition: true } } } } } } },
      },
    },
    orderBy: { placedAt: 'desc' },
  });
};

export const getBetById = async (id: string, userId: string, isAdmin = false) => {
  const bet = await prisma.bet.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true, email: true } },
      selections: { include: { selection: { include: { market: { include: { game: true } } } } } },
    },
  });
  if (!bet) throw new ApiError(404, 'Bet not found');
  if (!isAdmin && bet.userId !== userId) throw new ApiError(403, 'Not allowed to view this bet');
  return bet;
};

export const getAllBets = async (filters: Record<string, unknown> = {}) => {
  const where: Prisma.BetWhereInput = {};
  if (filters.status && typeof filters.status === 'string') where.status = filters.status as never;
  if (filters.userId && typeof filters.userId === 'string') where.userId = filters.userId;
  return prisma.bet.findMany({
    where,
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { placedAt: 'desc' },
  });
};

const bumpBalance = async (userId: string, amount: number | Prisma.Decimal, type: string, reference: string) => {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) return null;
    const balanceAfter = roundMoney(Number(user.balance) + Number(amount));
    await tx.user.update({ where: { id: userId }, data: { balance: { increment: amount } } });
    await tx.transaction.create({ data: { userId, type: type as never, amount, balanceAfter, reference } });
    return balanceAfter;
  });
};

export const recomputeBet = async (betId: string): Promise<number | null | undefined> => {
  const bet = await prisma.bet.findUnique({
    where: { id: betId },
    include: { selections: true },
  });
  if (!bet || bet.status !== 'PENDING') return undefined;

  const legs = bet.selections;
  if (legs.some((l) => l.result === 'LOST')) {
    await prisma.bet.update({ where: { id: betId }, data: { status: 'LOST', settledAt: new Date() } });
    return undefined;
  }
  if (legs.some((l) => l.result === 'PENDING')) return undefined;

  const voided = legs.filter((l) => l.result === 'VOID');
  if (voided.length === legs.length) {
    const balanceAfter = await bumpBalance(bet.userId, bet.stake, 'BET_REFUND', bet.id);
    await prisma.bet.update({ where: { id: betId }, data: { status: 'VOID', settledAt: new Date() } });
    return balanceAfter ?? undefined;
  }

  const activeOdds = legs
    .filter((l) => l.result === 'WON')
    .reduce((acc, l) => acc * Number(l.oddsAtPlacement), 1);
  const payout = roundMoney(Number(bet.stake) * (activeOdds || 1));
  const balanceAfter = await bumpBalance(bet.userId, payout, 'BET_WON', bet.id);
  await prisma.bet.update({ where: { id: betId }, data: { status: 'WON', settledAt: new Date() } });
  return balanceAfter ?? undefined;
};

export { bumpBalance };
