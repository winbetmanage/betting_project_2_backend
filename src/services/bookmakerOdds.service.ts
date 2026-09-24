import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import * as eplGameOdds from './eplGameOdds.service';

type GameWithComp = { specifications?: unknown; competition?: { name?: string | null } | null };

export function resolveSportKey(game: GameWithComp): string {
  const spec = (game.specifications ?? {}) as { sport_key?: unknown };
  if (typeof spec.sport_key === 'string' && spec.sport_key) return spec.sport_key;
  const name = (game.competition?.name ?? '').toLowerCase();
  if (name.includes('champions')) return 'soccer_uefa_champs_league';
  return 'soccer_epl';
}

export async function fetchAndStoreForGame(gameId: string) {
  const game = await prisma.game.findUnique({ where: { id: gameId }, include: { competition: true } });
  if (!game) throw new ApiError(404, 'Game not found');
  if (!game.externalEventId) throw new ApiError(400, 'Game has no externalEventId');
  const sportKey = resolveSportKey(game);
  // Per-event ALL-markets fetch (falls back gracefully) — saved to the game's JSON file
  const bookmakers = await eplGameOdds.fetchAndSaveEventOdds(game.externalEventId, sportKey);
  const lastFetchedAt = new Date().toISOString();
  const spec = { ...((game.specifications ?? {}) as Record<string, unknown>) };
  spec.lastFetchedAt = lastFetchedAt;
  spec.sport_key = spec.sport_key ?? sportKey;
  await prisma.game.update({ where: { id: gameId }, data: { specifications: spec as never } });
  return { stored: bookmakers, eventId: game.externalEventId, sportKey, lastFetchedAt };
}

export async function getGroupedForGame(gameId: string) {
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) throw new ApiError(404, 'Game not found');
  if (!game.externalEventId) return { game, groups: [] };

  const raw = eplGameOdds.readGameOdds(game.externalEventId);
  if (!raw) return { game, groups: [] };
  const groups = eplGameOdds.groupOdds(raw);
  return { game, groups };
}

export async function getGameApiDetails(gameId: string) {
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: {
      competition: { include: { sport: true } },
      score: {
        select: {
          footballDataMatchId: true, homeScoreHT: true, awayScoreHT: true,
          homeScoreFT: true, awayScoreFT: true, winner: true, status: true, fetchedAt: true,
        },
      },
      stagedGame: {
        select: {
          id: true, status: true, oddsApiRaw: true, footballDataRaw: true,
          footballDataStartTime: true, footballDataMatchId: true, oddsApiStartTime: true, footballDataStatus: true,
        },
      },
    },
  });
  if (!game) throw new ApiError(404, 'Game not found');

  const spec = (game.specifications ?? {}) as Record<string, unknown>;
  const sportKey = resolveSportKey(game);
  const externalEventId = game.externalEventId;

  const fdFromSpec = typeof spec.footballDataMatchId === 'number' ? spec.footballDataMatchId : null;
  const fdMatchId = fdFromSpec ?? game.score?.footballDataMatchId ?? game.stagedGame?.footballDataMatchId ?? null;
  const fdStartTime = (typeof spec.footballDataStartTime === 'string' ? spec.footballDataStartTime : null) ?? game.stagedGame?.footballDataStartTime ?? null;

  const file = { exists: false, fileName: externalEventId ? `${externalEventId}.json` : null, bookmakerCount: 0, marketCount: 0, updatedAt: null as string | null };
  if (externalEventId) {
    const info = eplGameOdds.getGameOddsFileInfo(externalEventId);
    if (info) {
      file.exists = true;
      file.bookmakerCount = info.bookmakerCount;
      file.marketCount = info.marketCount;
      file.updatedAt = info.updatedAt ? info.updatedAt.toISOString() : null;
    }
  }

  return {
    gameId: game.id,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    startTime: game.startTime,
    status: game.status,
    isPublished: game.isPublished,
    sportKey,
    competition: game.competition,
    oddsApi: {
      present: !!externalEventId,
      eventId: externalEventId,
      sportKey,
      lastFetchedAt: typeof spec.lastFetchedAt === 'string' ? spec.lastFetchedAt : null,
      file,
      rawEvent: game.stagedGame?.oddsApiRaw ?? null,
    },
    footballData: {
      present: fdMatchId != null,
      matchId: fdMatchId,
      startTime: fdStartTime,
      matchStatus: game.stagedGame?.footballDataStatus ?? null,
      raw: game.stagedGame?.footballDataRaw ?? null,
      score: game.score ?? null,
    },
    staged: game.stagedGame
      ? { id: game.stagedGame.id, status: game.stagedGame.status, footballDataStatus: game.stagedGame.footballDataStatus }
      : null,
  };
}

export { hasJsonFor, jsonPathFor, readGameOdds, groupOdds, fetchAndSaveGameOdds, fetchAndSaveEventOdds } from './eplGameOdds.service';
