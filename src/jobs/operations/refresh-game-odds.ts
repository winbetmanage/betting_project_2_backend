import prisma from '../../utils/prisma.js';
import { refreshGameOdds } from '../../services/gameOddsRefresh.service.js';

/**
 * Confirmed update intervals by time remaining to kickoff (published games only):
 *   > 7 days        -> every 24 h
 *   7 d .. 3 d      -> every 12 h
 *   3 d .. 24 h     -> every 6 h
 *   24 h .. 6 h     -> every 3 h
 *   <= 6 h          -> every 30 min
 *   started         -> STOP (only published SCHEDULED games are considered)
 */
export function oddsRefreshIntervalMs(startTime: Date, now: Date): number | null {
  const msLeft = new Date(startTime).getTime() - now.getTime();
  if (msLeft <= 0) return null; // kickoff passed — stop until status catches up
  const H = 3600 * 1000;
  if (msLeft > 7 * 24 * H) return 24 * H;
  if (msLeft > 3 * 24 * H) return 12 * H;
  if (msLeft > 24 * H) return 6 * H;
  if (msLeft > 6 * H) return 3 * H;
  return 30 * 60 * 1000;
}

export type OddsRefreshSummary = {
  candidates: number;
  due: number;
  refreshed: number;
  fresh: number;
  errored: number;
  details: { gameId: string; fixture: string; oddsChanged: number; marketsUpdated: number; notes: string[] }[];
};

let running = false;

export async function runRefreshGameOddsJob(): Promise<OddsRefreshSummary> {
  const summary: OddsRefreshSummary = { candidates: 0, due: 0, refreshed: 0, fresh: 0, errored: 0, details: [] };
  if (running) return summary;
  running = true;
  try {
    const now = new Date();
    const games = await prisma.game.findMany({
      where: { status: 'SCHEDULED', externalEventId: { not: null }, isPublished: true },
      select: { id: true, homeTeam: true, awayTeam: true, startTime: true, lastOddsFetchAt: true },
    });
    summary.candidates = games.length;

    for (const g of games) {
      const interval = oddsRefreshIntervalMs(g.startTime, now);
      if (interval == null) continue;
      const last = g.lastOddsFetchAt ? new Date(g.lastOddsFetchAt).getTime() : 0;
      if (now.getTime() - last < interval) {
        summary.fresh++;
        continue;
      }
      summary.due++;
      try {
        const r = await refreshGameOdds(g.id);
        summary.refreshed++;
        if (r.oddsChanged > 0 || r.notes.length > 0) {
          summary.details.push({ gameId: g.id, fixture: `${g.homeTeam} vs ${g.awayTeam}`, oddsChanged: r.oddsChanged, marketsUpdated: r.marketsUpdated, notes: r.notes });
        }
      } catch (e) {
        summary.errored++;
        console.error(`[refresh-game-odds] ${g.id} (${g.homeTeam} vs ${g.awayTeam}) failed:`, e instanceof Error ? e.message : String(e));
      }
    }
    return summary;
  } finally {
    running = false;
  }
}

export default runRefreshGameOddsJob;
