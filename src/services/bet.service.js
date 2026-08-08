const prisma = require('../utils/prisma');
const ApiError = require('../utils/ApiError');

const roundMoney = (value) => Math.round(value * 100) / 100;
const roundOdds = (value) => Math.round(value * 1000) / 1000;

const placeBet = async (userId, { type = 'SINGLE', stake, selections }) => {
  if (stake === undefined || Number(stake) <= 0) throw new ApiError(400, 'Stake must be positive');
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new ApiError(400, 'At least one selection is required');
  }
  const betType = ['SINGLE', 'MULTIPLE', 'SYSTEM'].includes(type) ? type : 'SINGLE';
  const stakeAmount = roundMoney(Number(stake));

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError(404, 'User not found');
  if (!user.isActive) throw new ApiError(403, 'Account is inactive');
  if (user.balance < stakeAmount) throw new ApiError(400, 'Insufficient balance');

  const requestedIds = [...new Set(selections.map((s) => s.selectionId))];
  const available = await prisma.selection.findMany({
    where: { id: { in: requestedIds }, market: { status: 'OPEN' } },
  });
  if (available.length !== requestedIds.length) {
    throw new ApiError(400, 'One or more selections are unavailable or their market is not open');
  }

  const byId = new Map(available.map((s) => [s.id, s]));
  const betSelections = requestedIds.map((id) => {
    const selection = byId.get(id);
    return { selectionId: id, oddsAtPlacement: selection.odds, result: 'PENDING' };
  });

  const totalOdds = roundOdds(betSelections.reduce((acc, s) => acc * s.oddsAtPlacement, 1));
  const potentialPayout = roundMoney(stakeAmount * totalOdds);

  const bet = await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { balance: { decrement: stakeAmount } } });
    await tx.transaction.create({
      data: {
        userId,
        type: 'BET_PLACED',
        amount: stakeAmount,
        balanceAfter: roundMoney(user.balance - stakeAmount),
        reference: 'bet',
      },
    });
    return tx.bet.create({
      data: {
        userId,
        type: betType,
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

const getUserBets = async (userId, filters = {}) => {
  const where = { userId };
  if (filters.status) where.status = filters.status;
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

const getBetById = async (id, userId, isAdmin = false) => {
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

const getAllBets = async (filters = {}) => {
  const where = {};
  if (filters.status) where.status = filters.status;
  if (filters.userId) where.userId = filters.userId;
  return prisma.bet.findMany({
    where,
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { placedAt: 'desc' },
  });
};

const recomputeBet = async (betId) => {
  const bet = await prisma.bet.findUnique({
    where: { id: betId },
    include: { selections: true },
  });
  if (!bet || bet.status !== 'PENDING') return;

  const legs = bet.selections;
  if (legs.some((l) => l.result === 'LOST')) {
    await prisma.bet.update({ where: { id: betId }, data: { status: 'LOST', settledAt: new Date() } });
    return;
  }
  if (legs.some((l) => l.result === 'PENDING')) return;

  const voided = legs.filter((l) => l.result === 'VOID');
  if (voided.length === legs.length) {
    const balanceAfter = await bumpBalance(bet.userId, bet.stake, 'BET_REFUND', bet.id);
    await prisma.bet.update({ where: { id: betId }, data: { status: 'VOID', settledAt: new Date() } });
    return balanceAfter;
  }

  const activeOdds = legs
    .filter((l) => l.result === 'WON')
    .reduce((acc, l) => acc * l.oddsAtPlacement, 1);
  const payout = roundMoney(bet.stake * activeOdds);
  const balanceAfter = await bumpBalance(bet.userId, payout, 'BET_WON', bet.id);
  await prisma.bet.update({ where: { id: betId }, data: { status: 'WON', settledAt: new Date() } });
  return balanceAfter;
};

const bumpBalance = async (userId, amount, type, reference) => {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) return null;
    const balanceAfter = roundMoney(user.balance + amount);
    await tx.user.update({ where: { id: userId }, data: { balance: { increment: amount } } });
    await tx.transaction.create({ data: { userId, type, amount, balanceAfter, reference } });
    return balanceAfter;
  });
};

module.exports = { placeBet, getUserBets, getBetById, getAllBets, recomputeBet, bumpBalance };
