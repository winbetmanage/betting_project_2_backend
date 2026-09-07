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

export const listRecentResults = async (limit: number) => {
  return prisma.game.findMany({
    where: { status: 'FINISHED', score: { isNot: null } },
    orderBy: { startTime: 'desc' },
    take: Math.min(Math.max(limit, 1), 50),
    include: {
      score: true,
      competition: { include: { sport: true } },
    },
  });
};

export const deleteGames = async (ids: unknown) => {
  if (!Array.isArray(ids) || ids.length === 0) throw new ApiError(400, 'No games selected');
  const idList = Array.from(new Set(ids.filter((v): v is string => typeof v === 'string' && v.trim() !== '')));
  if (idList.length === 0) throw new ApiError(400, 'No valid game ids provided');

  const games = await prisma.game.findMany({
    where: { id: { in: idList } },
    select: { id: true, isPublished: true, homeTeam: true, awayTeam: true },
  });
  if (games.length === 0) throw new ApiError(404, 'No matching games found');

  // Published games are protected
  const published = games.filter((g) => g.isPublished);
  if (published.length > 0) {
    throw new ApiError(
      400,
      `Cannot delete published games: ${published.map((g) => `${g.homeTeam} vs ${g.awayTeam}`).join(', ')}`
    );
  }

  const deletableIds = games.map((g) => g.id);

  // Refuse when bets reference the games' selections (BetSelection cascades with Selection)
  const markets = await prisma.market.findMany({
    where: { gameId: { in: deletableIds } },
    select: { id: true },
  });
  const marketIds = markets.map((m) => m.id);
  if (marketIds.length > 0) {
    const betSelectionCount = await prisma.betSelection.count({
      where: { selection: { marketId: { in: marketIds } } },
    });
    if (betSelectionCount > 0) {
      throw new ApiError(400, 'Cannot delete: one or more selected games have bets placed on their markets');
    }
  }

  const deleted = await prisma.$transaction(async (tx) => {
    if (marketIds.length > 0) {
      await tx.selection.deleteMany({ where: { marketId: { in: marketIds } } });
      await tx.market.deleteMany({ where: { id: { in: marketIds } } });
    }
    await tx.gameScore.deleteMany({ where: { gameId: { in: deletableIds } } });
    // OddsFetchCheckpoint rows cascade with the game
    await tx.game.deleteMany({ where: { id: { in: deletableIds } } });
    return deletableIds.length;
  });

  console.log(`[game.service] deleted ${deleted} game(s): ${deletableIds.join(', ')}`);
  return { deleted, ids: deletableIds };
};
