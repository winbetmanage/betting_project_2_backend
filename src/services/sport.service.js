const prisma = require('../utils/prisma');
const ApiError = require('../utils/ApiError');

const createSport = async (data) => {
  return prisma.sport.create({ data });
};

const listSports = async (filters = {}) => {
  const where = {};
  if (filters.gameType) where.gameType = filters.gameType;
  return prisma.sport.findMany({
    where,
    include: { _count: { select: { competitions: true } } },
    orderBy: { name: 'asc' },
  });
};

const getSportById = async (id) => {
  const sport = await prisma.sport.findUnique({
    where: { id },
    include: { competitions: { include: { _count: { select: { games: true } } } } },
  });
  if (!sport) throw new ApiError(404, 'Sport not found');
  return sport;
};

const updateSport = async (id, data) => {
  return prisma.sport.update({ where: { id }, data });
};

module.exports = { createSport, listSports, getSportById, updateSport };
