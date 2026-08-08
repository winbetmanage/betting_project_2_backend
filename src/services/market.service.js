const prisma = require('../utils/prisma');
const ApiError = require('../utils/ApiError');
const { recomputeBet } = require('./bet.service');

const createMarket = async (gameId, data) => {
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) throw new ApiError(404, 'Game not found');
  return prisma.market.create({ data: { ...data, gameId }, include: { selections: true } });
};

const listMarkets = async (gameId) => {
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) throw new ApiError(404, 'Game not found');
  return prisma.market.findMany({ where: { gameId }, include: { selections: true } });
};

const getMarketById = async (id) => {
  const market = await prisma.market.findUnique({
    where: { id },
    include: { selections: true, game: true },
  });
  if (!market) throw new ApiError(404, 'Market not found');
  return market;
};

const updateMarket = async (id, data) => {
  return prisma.market.update({ where: { id }, data, include: { selections: true } });
};

const addSelection = async (marketId, data) => {
  const market = await prisma.market.findUnique({ where: { id: marketId } });
  if (!market) throw new ApiError(404, 'Market not found');
  return prisma.selection.create({ data: { ...data, marketId } });
};

const updateSelection = async (id, data) => {
  return prisma.selection.update({ where: { id }, data });
};

const updateOdds = async (id, odds) => {
  if (odds <= 0) throw new ApiError(400, 'Odds must be positive');
  const selection = await prisma.selection.update({
    where: { id },
    data: { odds },
    include: { market: true },
  });
  await prisma.oddsHistory.create({ data: { selectionId: id, odds } });
  return selection;
};

const settleSelection = async (id, isWinning) => {
  const selection = await prisma.selection.findUnique({
    where: { id },
    include: { market: true },
  });
  if (!selection) throw new ApiError(404, 'Selection not found');
  if (selection.market.status === 'SETTLED') throw new ApiError(400, 'Market already settled');
  if (selection.isWinning !== null && selection.isWinning !== isWinning) {
    throw new ApiError(400, 'Selection already settled with a different result');
  }

  await prisma.selection.update({ where: { id }, data: { isWinning } });

  const openBetSelections = await prisma.betSelection.findMany({
    where: { selectionId: id, result: 'PENDING' },
    select: { id: true, betId: true },
  });
  for (const bs of openBetSelections) {
    await prisma.betSelection.update({ where: { id: bs.id }, data: { result: isWinning ? 'WON' : 'LOST' } });
    await recomputeBet(bs.betId);
  }

  const allSelections = await prisma.selection.findMany({ where: { marketId: selection.marketId } });
  if (allSelections.every((s) => s.isWinning !== null)) {
    await prisma.market.update({ where: { id: selection.marketId }, data: { status: 'SETTLED' } });
  }

  return { id, isWinning };
};

module.exports = {
  createMarket,
  listMarkets,
  getMarketById,
  updateMarket,
  addSelection,
  updateSelection,
  updateOdds,
  settleSelection,
};
