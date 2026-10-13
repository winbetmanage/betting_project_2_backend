import * as bookmakerOddsService from '../services/bookmakerOdds.service';
import * as marketApprovalService from '../services/marketApproval.service';
import asyncHandler from '../utils/asyncHandler';
import prisma from '../utils/prisma';

export const fetchForGame = asyncHandler(async (req, res) => {
  const minimal = !!(req.body as { minimal?: unknown } | undefined)?.minimal;
  const result = await bookmakerOddsService.fetchAndStoreForGame(req.params.id as string, { minimal });
  res.json({ message: `Fetched ${result.stored} odds${result.minimal ? " (minimalistic)" : ""}`, data: result });
});

export const apiDetails = asyncHandler(async (req, res) => {
  const data = await bookmakerOddsService.getGameApiDetails(req.params.id as string);
  res.json({ data });
});

export const getGroupedForGame = asyncHandler(async (req, res) => {
  const result = await bookmakerOddsService.getGroupedForGame(req.params.id as string);
  const gameId = req.params.id as string;
  const game = await prisma.game.findUnique({ where: { id: gameId }, include: { markets: true } });
  const hasJson = result.game.externalEventId ? bookmakerOddsService.hasJsonFor(result.game.externalEventId) : false;
  const hasSelection = (game?.markets?.length ?? 0) > 0;
  // Which group keys already have a saved Market (to highlight in UI)
  const TYPE_TO_KEY: Record<string, string> = { MATCH_WINNER: 'h2h', OVER_UNDER: 'totals', HANDICAP: 'spreads', BOTH_TEAMS_TO_SCORE: 'btts', CORRECT_SCORE: 'correct_score' };
  const savedKeys = (game?.markets ?? [])
    .map((m) => {
      const p = m.parameters as { marketKey?: string; line?: number | null } | null;
      const mk = p?.marketKey ?? TYPE_TO_KEY[m.type] ?? m.type.toLowerCase();
      const pt = p?.line != null ? String(p.line) : 'null';
      return `${mk}::${pt}`;
    });
  res.json({ data: result.groups, game: result.game, hasJson, hasSelection, savedKeys });
});

export const approveMarket = asyncHandler(async (req, res) => {
  const gameId = req.params.id as string;
  const adminUserId = req.user!.id;
  const { marketKey, point, bookmakerKey, selections } = req.body as {
    marketKey: string;
    point?: number | null;
    bookmakerKey: string;
    selections: { name: string; odds: number }[];
  };
  const market = await marketApprovalService.approveMarket(gameId, { marketKey, point: point ?? null, bookmakerKey, selections }, adminUserId);
  res.json({ message: 'Market approved', data: market });
});

const TRANSIENT_DB = ["Server has closed", "max_statement_time", "Can't reach", "Timed out", "ETIMEDOUT", "ECONNRESET", "connection", "P1001", "P1017"];

async function withRetry<T>(fn: () => Promise<T>, tries = 4, waitMs = 800): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (TRANSIENT_DB.some((s) => msg.includes(s))) {
        await new Promise((r) => setTimeout(r, waitMs * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw last;
}

// Run async tasks with a bounded concurrency so a large batch finishes fast
// without hammering the database, and every item is attempted regardless of
// another item's failure.
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

export const approveMarketsBulk = asyncHandler(async (req, res) => {
  const gameId = req.params.id as string;
  const adminUserId = req.user!.id;
  const { approvals } = req.body as {
    approvals: { marketKey: string; point?: number | null; bookmakerKey: string; selections: { name: string; odds: number }[] }[];
  };
  if (!Array.isArray(approvals) || approvals.length === 0) {
    res.status(400).json({ message: 'approvals array required' });
    return;
  }

  const results = await mapLimit(approvals, 6, async (a) => {
    try {
      const market = await withRetry(() =>
        marketApprovalService.approveMarket(
          gameId,
          { marketKey: a.marketKey, point: a.point ?? null, bookmakerKey: a.bookmakerKey, selections: a.selections },
          adminUserId
        )
      );
      return { marketKey: a.marketKey, point: a.point ?? null, success: true, marketId: market!.id };
    } catch (e) {
      return { marketKey: a.marketKey, point: a.point ?? null, success: false, message: e instanceof Error ? e.message : 'Failed' };
    }
  });

  const ok = results.filter((r) => r.success).length;
  res.json({ message: `${ok}/${results.length} markets recorded`, data: results });
});
