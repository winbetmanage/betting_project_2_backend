import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import type { Prisma } from '@prisma/client';

export const createSport = async (data: Prisma.SportCreateInput) => {
  return prisma.sport.create({ data });
};

export const listSports = async (filters: Record<string, unknown> = {}) => {
  const where: Prisma.SportWhereInput = {};
  if (filters.gameType && typeof filters.gameType === 'string') where.gameType = filters.gameType as never;
  return prisma.sport.findMany({
    where,
    include: { _count: { select: { competitions: true } } },
    orderBy: { name: 'asc' },
  });
};

export const getSportById = async (id: string) => {
  const sport = await prisma.sport.findUnique({
    where: { id },
    include: { competitions: { include: { _count: { select: { games: true } } } } },
  });
  if (!sport) throw new ApiError(404, 'Sport not found');
  return sport;
};

export const updateSport = async (id: string, data: Prisma.SportUpdateInput) => {
  return prisma.sport.update({ where: { id }, data });
};
