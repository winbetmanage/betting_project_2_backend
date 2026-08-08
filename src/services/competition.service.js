const prisma = require('../utils/prisma');
const ApiError = require('../utils/ApiError');

const createCompetition = async (data) => {
  return prisma.competition.create({ data, include: { sport: true } });
};

const listCompetitions = async (filters = {}) => {
  const where = {};
  if (filters.sportId) where.sportId = filters.sportId;
  return prisma.competition.findMany({
    where,
    include: { sport: true, _count: { select: { games: true } } },
    orderBy: { name: 'asc' },
  });
};

const getCompetitionById = async (id) => {
  const competition = await prisma.competition.findUnique({
    where: { id },
    include: { sport: true, games: { include: { markets: { include: { selections: true } } } } },
  });
  if (!competition) throw new ApiError(404, 'Competition not found');
  return competition;
};

const updateCompetition = async (id, data) => {
  return prisma.competition.update({ where: { id }, data, include: { sport: true } });
};

module.exports = { createCompetition, listCompetitions, getCompetitionById, updateCompetition };
