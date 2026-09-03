import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import type { Prisma } from '@prisma/client';

export const createCompetition = async (data: Prisma.CompetitionCreateInput | Record<string, unknown>) => {
  return prisma.competition.create({ data: data as never, include: { sport: true } });
};

export const listCompetitions = async (filters: Record<string, unknown> = {}) => {
  const where: Prisma.CompetitionWhereInput = {};
  if (filters.sportId && typeof filters.sportId === 'string') where.sportId = filters.sportId as string;
  return prisma.competition.findMany({
    where,
    include: { sport: true, _count: { select: { games: true } } },
    orderBy: { name: 'asc' },
  });
};

export const getCompetitionById = async (id: string) => {
  const competition = await prisma.competition.findUnique({
    where: { id },
    include: { sport: true, games: { include: { markets: { include: { selections: true } } } } },
  });
  if (!competition) throw new ApiError(404, 'Competition not found');
  return competition;
};

export const updateCompetition = async (id: string, data: Record<string, unknown>) => {
  return prisma.competition.update({ where: { id }, data: data as never, include: { sport: true } });
};
