import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import type { Prisma } from '@prisma/client';

export const createGame = async (data: Prisma.GameCreateInput | Record<string, unknown>) => {
  return prisma.game.create({ data: data as Prisma.GameCreateInput, include: { competition: { include: { sport: true } } } });
};

export const listGames = async (filters: Record<string, unknown> = {}) => {
  const where: Prisma.GameWhereInput = {};
  if (filters.status && typeof filters.status === 'string') where.status = filters.status as never;
  if (filters.competitionId && typeof filters.competitionId === 'string') where.competitionId = filters.competitionId as string;
  if (filters.sportId && typeof filters.sportId === 'string') where.competition = { sportId: filters.sportId as string };
  if (filters.isPublished !== undefined && filters.isPublished !== '') {
    where.isPublished = filters.isPublished === 'true' || filters.isPublished === true;
  }

  if (filters.from || filters.to) {
    where.startTime = {};
    if (filters.from) (where.startTime as Prisma.DateTimeFilter).gte = new Date(filters.from as string);
    if (filters.to) (where.startTime as Prisma.DateTimeFilter).lte = new Date(filters.to as string);
  }

  return prisma.game.findMany({
    where,
    include: {
      competition: { include: { sport: true } },
      ...(filters.include === 'markets'
        ? { markets: { include: { selections: { orderBy: { name: 'asc' as const } } } } }
        : {}),
    },
    orderBy: { startTime: 'asc' },
  });
};

export const getGameById = async (id: string) => {
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

export const updateGame = async (id: string, data: Record<string, unknown>) => {
  return prisma.game.update({ where: { id }, data: data as never });
};
