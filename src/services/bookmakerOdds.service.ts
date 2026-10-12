import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import fs from 'fs';
import path from 'path';
import * as eplGameOdds from './eplGameOdds.service';
import * as marketApprovalService from './marketApproval.service';

type GameWithComp = { specifications?: unknown; competition?: { name?: string | null } | null };

/** Market keys that are NOT settled on goals (corners/cards) — hidden in "Scores only". */
export const NON_SCORE_MARKET_KEYS = new Set([
  'corners_1x2',
  'alternate_totals_corners',
  'alternate_spreads_corners',
  'alternate_totals_cards',
  'alternate_spreads_cards',
]);

/** Registry of every known market key + label, for the exclude picker. */
export function listMarketTypes(): { key: string; label: string; scoreRelated: boolean }[] {
  const candidates = [
    path.join(__dirname, '..', 'config', 'marketTypes.json'),
    path.join(process.cwd(), 'src', 'config', 'marketTypes.json'),
  ];
  for (const f of candidates) {
    try {
      if (fs.existsSync(f)) {
        const raw = JSON.parse(fs.readFileSync(f, 'utf-8')) as Record<string, { type?: string; label?: string }>;
        return Object.entries(raw)
          .filter(([k]) => !k.startsWith('_'))
          .map(([key, v]) => ({ key, label: v.label ?? key, scoreRelated: !NON_SCORE_MARKET_KEYS.has(key) }))
          .sort((a, b) => a.label.localeCompare(b.label));
      }
    } catch {
      // fall through
    }
  }
  return [];
}

export function resolveSportKey(game: GameWithComp): string {
  const spec = (game.specifications ?? {}) as { sport_key?: unknown };
  if (typeof spec.sport_key === 'string' && spec.sport_key) return spec.sport_key;
  const name = (game.competition?.name ?? '').toLowerCase();
  if (name.includes('champions')) return 'soccer_uefa_champs_league';
  if (name.includes('la liga')) return 'soccer_spain_la_liga';
  if (name.includes('bundesliga')) return 'soccer_germany_bundesliga';
  if (name.includes('serie a')) return 'soccer_italy_serie_a';
  if (name.includes('ligue')) return 'soccer_france_ligue_one';
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

// ============================================================================
// Bulk operations for the "advanced" admin flow (Active Games page)
// ============================================================================

export type BulkFetchItem = {
  gameId: string;
  label: string;
  ok: boolean;
  stored?: number;
  attempts: number;
  error?: string;
};

export type BulkFillItem = {
  gameId: string;
  label: string;
  marketsFilled: number;
  marketsFailed: number;
  skipped: number;
  failures: { marketKey: string; point: number | null; message: string }[];
  error?: string;
};

export type BulkReport = {
  action: 'fetch' | 'fill';
  total: number;
  succeeded: number;
  failed: number;
  items: (BulkFetchItem | BulkFillItem)[];
};

/** Retry a single attempt twice; on the 2nd failure return the error instead of throwing. */
async function attemptTwice<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T; attempts: number } | { ok: false; error: string; attempts: number }> {
  let lastErr = '';
  for (let i = 0; i < 2; i++) {
    try {
      const value = await fn();
      return { ok: true, value, attempts: i + 1 };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error: lastErr, attempts: 2 };
}

const gameLabel = (homeTeam: string, awayTeam: string) => `${homeTeam} vs ${awayTeam}`;

/** Auto fetch markets for many games. Per game: retry twice, then skip and report. */
export async function bulkFetchOdds(ids: string[]): Promise<BulkReport> {
  const games = await prisma.game.findMany({ where: { id: { in: ids } }, select: { id: true, homeTeam: true, awayTeam: true } });
  const byId = new Map(games.map((g) => [g.id, g]));
  const items: BulkFetchItem[] = [];

  for (const id of ids) {
    const g = byId.get(id);
    const label = g ? gameLabel(g.homeTeam, g.awayTeam) : id.slice(0, 8);
    const res = await attemptTwice(() => fetchAndStoreForGame(id));
    if (res.ok) items.push({ gameId: id, label, ok: true, stored: res.value.stored, attempts: res.attempts });
    else items.push({ gameId: id, label, ok: false, attempts: res.attempts, error: res.error });
  }

  const succeeded = items.filter((i) => i.ok).length;
  return { action: 'fetch', total: items.length, succeeded, failed: items.length - succeeded, items };
}

/**
 * Auto fill markets for many games: for each game, pick the first bookmaker for
 * every grouped market and approve it, honouring `scoreOnly` (skip corners/cards)
 * and `excludeMarketKeys` (skip listed market keys). Each market is attempted
 * twice; on the 2nd failure it is skipped and recorded in the report.
 */
export async function bulkAutoFill(
  ids: string[],
  opts: { scoreOnly: boolean; excludeMarketKeys: string[]; adminUserId: string }
): Promise<BulkReport> {
  const exclude = new Set(opts.excludeMarketKeys);
  const games = await prisma.game.findMany({
    where: { id: { in: ids } },
    select: { id: true, homeTeam: true, awayTeam: true, externalEventId: true },
  });
  const byId = new Map(games.map((g) => [g.id, g]));
  const items: BulkFillItem[] = [];

  // One odds fetch per sport key, shared across that sport's games.
  for (const id of ids) {
    const g = byId.get(id);
    const label = g ? gameLabel(g.homeTeam, g.awayTeam) : id.slice(0, 8);
    if (!g || !g.externalEventId) {
      items.push({ gameId: id, label, marketsFilled: 0, marketsFailed: 0, skipped: 0, failures: [], error: 'No external event id' });
      continue;
    }

    let groups: eplGameOdds.BookmakerGroup[];
    try {
      const grouped = await getGroupedForGame(id);
      groups = grouped.groups;
    } catch (e) {
      items.push({ gameId: id, label, marketsFilled: 0, marketsFailed: 0, skipped: 0, failures: [], error: e instanceof Error ? e.message : 'Failed to read odds' });
      continue;
    }

    const eligible = groups.filter((grp) => {
      if (exclude.has(grp.marketKey)) return false;
      if (opts.scoreOnly && NON_SCORE_MARKET_KEYS.has(grp.marketKey)) return false;
      return !!grp.bookmakers[0];
    });

    let filled = 0;
    let failed = 0;
    const failures: { marketKey: string; point: number | null; message: string }[] = [];

    for (const grp of eligible) {
      const bm = grp.bookmakers[0];
      const selections = bm.outcomes.map((o) => ({ name: o.name, odds: Number(o.price) })).filter((s) => s.odds > 1);
      if (selections.length === 0) {
        failed++;
        failures.push({ marketKey: grp.marketKey, point: grp.point, message: 'No valid selections' });
        continue;
      }
      const res = await attemptTwice(() =>
        marketApprovalService.approveMarket(
          id,
          { marketKey: grp.marketKey, point: grp.point, bookmakerKey: bm.bookmakerKey, selections },
          opts.adminUserId
        )
      );
      if (res.ok) filled++;
      else {
        failed++;
        failures.push({ marketKey: grp.marketKey, point: grp.point, message: res.error });
      }
    }

    items.push({
      gameId: id,
      label,
      marketsFilled: filled,
      marketsFailed: failed,
      skipped: groups.length - eligible.length,
      failures,
    });
  }

  const succeeded = items.filter((i) => !i.error && i.marketsFailed === 0).length;
  return { action: 'fill', total: items.length, succeeded, failed: items.length - succeeded, items };
}
