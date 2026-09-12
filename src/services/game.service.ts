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

  const games = await prisma.game.findMany({
    where,
    include: {
      competition: { include: { sport: true } },
      score: { select: { footballDataMatchId: true, homeScoreHT: true, awayScoreHT: true, homeScoreFT: true, awayScoreFT: true, winner: true, status: true } },
      ...(filters.include === 'markets'
        ? { markets: { include: { selections: { orderBy: { name: 'asc' as const } } } } }
        : {}),
    },
    orderBy: { startTime: 'asc' },
  });

  return games.map((g) => {
    const spec = (g.specifications ?? {}) as Record<string, unknown>;
    const fdMatchId = (typeof spec.footballDataMatchId === 'number' ? spec.footballDataMatchId : null) ?? g.score?.footballDataMatchId ?? null;
    const compName = (g.competition?.name ?? '').toLowerCase();
    const apiSportKey = typeof spec.sport_key === 'string' && spec.sport_key
      ? spec.sport_key
      : compName.includes('champions')
        ? 'soccer_uefa_champs_league'
        : compName
          ? 'soccer_epl'
          : null;
    const score = g.score
      ? {
          footballDataMatchId: g.score.footballDataMatchId,
          homeHT: g.score.homeScoreHT,
          awayHT: g.score.awayScoreHT,
          homeFT: g.score.homeScoreFT,
          awayFT: g.score.awayScoreFT,
          winner: g.score.winner,
          status: g.score.status,
        }
      : null;
    return {
      ...g,
      score,
      footballDataMatchId: fdMatchId,
      hasOddsApi: !!g.externalEventId,
      hasFootballData: fdMatchId != null,
      apiSportKey,
    };
  });
};

export const getGameById = async (id: string) => {
  const game = await prisma.game.findUnique({
    where: { id },
    include: {
      competition: { include: { sport: true } },
      markets: { include: { selections: true } },
      score: true,
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

export const CLEAR_GAMES_CONFIRM_PHRASE = 'DELETE ALL GAMES';

export const clearAllGameData = async ({ confirm, adminId }: { confirm?: unknown; adminId?: string }) => {
  if (typeof confirm !== 'string' || confirm.trim() !== CLEAR_GAMES_CONFIRM_PHRASE) {
    throw new ApiError(400, `Confirmation mismatch. Type "${CLEAR_GAMES_CONFIRM_PHRASE}" exactly to proceed.`);
  }

  const summary = await prisma.$transaction(
    async (tx) => {
      // Detach staged games from their confirmed Game rows so the FK clears cleanly
      await tx.stagedGame.updateMany({ where: { gameId: { not: null } }, data: { gameId: null } });

      const betSelections = await tx.betSelection.deleteMany({});
      const bets = await tx.bet.deleteMany({});
      const oddsHistories = await tx.oddsHistory.deleteMany({});
      const selections = await tx.selection.deleteMany({});
      const markets = await tx.market.deleteMany({});
      const scores = await tx.gameScore.deleteMany({});
      const checkpoints = await tx.oddsFetchCheckpoint.deleteMany({});
      const games = await tx.game.deleteMany({});

      const result = {
        games: games.count,
        markets: markets.count,
        selections: selections.count,
        oddsHistories: oddsHistories.count,
        scores: scores.count,
        checkpoints: checkpoints.count,
        bets: bets.count,
        betSelections: betSelections.count,
      };

      if (adminId) {
        await tx.adminActionLog.create({
          data: {
            userId: adminId,
            action: 'GAME_DATA_CLEARED',
            targetType: 'Game',
            metadata: result as unknown as Prisma.InputJsonValue,
          },
        });
      }
      return result;
    },
    { timeout: 120000, maxWait: 15000 }
  );

  console.log(`[game.service] CLEARED ALL GAME DATA: ${JSON.stringify(summary)}`);
  return summary;
};
