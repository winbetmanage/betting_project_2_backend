const prisma = require('../utils/prisma');
const ApiError = require('../utils/ApiError');

const createGame = async (data) => {
  return prisma.game.create({ data, include: { competition: { include: { sport: true } } } });
};

const listGames = async (filters = {}) => {
  const where = {};
  if (filters.status) where.status = filters.status;
  if (filters.competitionId) where.competitionId = filters.competitionId;
  if (filters.sportId) where.competition = { sportId: filters.sportId };

  const startTime = filters.from || filters.to;
  if (startTime) {
    where.startTime = {};
    if (filters.from) where.startTime.gte = new Date(filters.from);
    if (filters.to) where.startTime.lte = new Date(filters.to);
  }

  return prisma.game.findMany({
    where,
    include: {
      competition: { include: { sport: true } },
      ...(filters.include === 'markets'
        ? { markets: { include: { selections: { orderBy: { name: 'asc' } } } } }
        : {}),
    },
    orderBy: { startTime: 'asc' },
  });
};

const getGameById = async (id) => {
  const game = await prisma.game.findUnique({
    where: { id },
    include: {
      competition: { include: { sport: true } },
      markets: { include: { selections: true } },
    },
  });
  if (!game) throw new ApiError(404, 'Game not found');
  return game;
};

const updateGame = async (id, data) => {
  return prisma.game.update({ where: { id }, data });
};

module.exports = { createGame, listGames, getGameById, updateGame };
