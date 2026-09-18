import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import type { Prisma } from '@prisma/client';
import { getNumberSetting } from './settings.service';

const roundMoney = (value: number | Prisma.Decimal): number => Math.round(Number(value) * 100) / 100;
const roundOdds = (value: number): number => Math.round(value * 1000) / 1000;

export interface PlaceBetInput {
  type?: string;
  stake: number | string;
  selections: Array<{ selectionId: string; odds?: number }>;
}

export const MAX_PARLAY_LEGS = 15;

/** Betting window shuts this long before kickoff (checked at placement time). */
export const BETTING_WINDOW_MS = 15 * 60 * 1000;

export const placeBet = async (userId: string, { type, stake, selections }: PlaceBetInput) => {
  if (stake === undefined || Number(stake) <= 0) throw new ApiError(400, 'Stake must be positive');
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new ApiError(400, 'At least one selection is required');
  }
  if (selections.length > MAX_PARLAY_LEGS) {
    throw new ApiError(400, `A bet slip can contain at most ${MAX_PARLAY_LEGS} selections`);
  }
  if (type === 'SYSTEM') throw new ApiError(400, 'System bets are not supported');
  // Type is derived server-side: 1 leg = SINGLE, more = MULTIPLE
  const betType = selections.length === 1 ? 'SINGLE' : 'MULTIPLE';
  const stakeAmount = roundMoney(Number(stake));

  const requestedIds = selections.map((s) => s.selectionId);
  if (new Set(requestedIds).size !== requestedIds.length) {
    throw new ApiError(400, 'Duplicate selections are not allowed in one bet slip');
  }

  // Fetch selections with market status validation + also fetch current odds for stale-check
  const available = await prisma.selection.findMany({
    where: { id: { in: requestedIds }, market: { status: 'OPEN' } },
    include: { market: { select: { id: true, status: true, gameId: true, name: true, game: { select: { status: true, startTime: true } } } } },
  });
  if (available.length !== requestedIds.length) {
    throw new ApiError(400, 'One or more selections are unavailable or their market is not open');
  }

  // One selection per market (same-game combos across different markets are allowed)
  const marketIds = available.map((sel) => sel.market.id);
  if (new Set(marketIds).size !== marketIds.length) {
    const dup = available.find((sel, i) => marketIds.indexOf(sel.market.id) !== i);
    throw new ApiError(400, `Only one selection per market is allowed — "${dup?.market.name ?? 'a market'}" appears twice on this slip`);
  }

  // Game not started / betting window / odds stale validation
  for (const sel of available) {
    const game = (sel.market as { game?: { status: string; startTime: Date } }).game;
    if (game && game.status !== 'SCHEDULED') {
      throw new ApiError(400, `Market for selection ${sel.id} is no longer open for betting (game status: ${game.status})`);
    }
    const msToStart = game ? new Date(game.startTime).getTime() - Date.now() : Infinity;
    if (game && msToStart <= 0) {
      throw new ApiError(400, `Game for selection ${sel.id} has already started`);
    }
    if (game && msToStart <= BETTING_WINDOW_MS) {
      throw new ApiError(400, `Betting window closed for selection ${sel.id} (kickoff in ${Math.max(1, Math.ceil(msToStart / 60000))} min — cutoff is 15 min)`);
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

  // Funds + max-stake checked last so structural slip errors surface first
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError(404, 'User not found');
  if (!user.isActive) throw new ApiError(403, 'Account is inactive');

  const availableBalance = Number(user.balance) - Number((user as { heldBalance?: unknown }).heldBalance ?? 0);

  const maxStake = await getNumberSetting('betting.max_stake', Number.POSITIVE_INFINITY);
  if (stakeAmount > maxStake) throw new ApiError(400, `Maximum stake per bet is ETB ${maxStake}`);
  if (availableBalance < stakeAmount) throw new ApiError(400, 'Insufficient balance');

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
  }, { timeout: 20000, maxWait: 10000 });

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

export type GradeOutcome = { status: 'WON' | 'LOST' | 'VOID'; payout: number; credited: boolean };

/**
 * Shared parlay-aware grader. MUST be called with the same `tx` that updated the
 * BetSelection results, so grading, the balance credit and the ledger Transaction
 * all commit or roll back atomically.
 *
 * Rules (parlay):
 *  - any LOST leg -> bet LOST immediately, payout 0 (no waiting for other legs)
 *  - else if any leg still PENDING -> no-op (wait), except VOID handling below
 *  - VOID legs are excluded  -> payout = stake x product of WON legs (VOID treated as 1.0)
 *  - all legs VOID           -> bet VOID, stake refunded (BET_REFUND)
 *  - all non-void legs WON   -> bet WON, payout = stake x product of WON legs (BET_WON)
 * Writes Bet.status/settledAt/settledPayout; credited bets get payoutStatus SUBMITTED.
 * Pass opts.settledById ONLY for manual admin-forced settlement (settleSingleBet);
 * automatic paths leave it null.
 */
export async function gradeBetIfComplete(tx: Prisma.TransactionClient, betId: string, opts?: { settledById?: string }): Promise<GradeOutcome | null> {
  const bet = await tx.bet.findUnique({ where: { id: betId }, include: { selections: true } });
  if (!bet || bet.status !== 'PENDING') return null;
  const legs = bet.selections;
  if (legs.length === 0) return null;

  // A dead leg kills the ticket immediately — no need to wait for the rest
  // (standard parlay rule; VOID legs are still excluded from the odds product).
  const stake = Number(bet.stake);
  let status: 'WON' | 'LOST' | 'VOID';
  let payout = 0;
  if (legs.some((l) => l.result === 'LOST')) {
    status = 'LOST';
  } else if (legs.some((l) => l.result === 'PENDING')) {
    return null;
  } else if (legs.every((l) => l.result === 'VOID')) {
    status = 'VOID';
    payout = stake;
  } else {
    status = 'WON';
    payout = roundMoney(stake * legs.filter((l) => l.result === 'WON').reduce((acc, l) => acc * Number(l.oddsAtPlacement), 1));
  }

  const credited = status === 'WON' || status === 'VOID';
  if (credited) {
    const user = await tx.user.findUnique({ where: { id: bet.userId } });
    if (!user) throw new ApiError(404, 'User not found while crediting bet payout');
    const balanceAfter = roundMoney(Number(user.balance) + payout);
    await tx.user.update({ where: { id: bet.userId }, data: { balance: { increment: payout } } });
    await tx.transaction.create({
      data: { userId: bet.userId, type: status === 'WON' ? 'BET_WON' : 'BET_REFUND', amount: payout, balanceAfter, reference: bet.id },
    });
  }

  await tx.bet.update({
    where: { id: betId },
    data: {
      status,
      settledAt: new Date(),
      settledPayout: payout,
      ...(credited ? { payoutStatus: 'SUBMITTED' as const } : {}),
      ...(opts?.settledById ? { settledById: opts.settledById } : {}),
    },
  });
  return { status, payout, credited };
}

/** Standalone regrade (outside any tx) — opens its own transaction so credit stays atomic. */
export const recomputeBet = async (betId: string): Promise<GradeOutcome | null> => {
  return prisma.$transaction((tx) => gradeBetIfComplete(tx, betId));
};

export { bumpBalance };
