import prisma from '../../utils/prisma.js';
import * as eplGameOdds from '../../services/eplGameOdds.service.js';

const CHECKPOINTS = [
  { key: '24h', ms: 24 * 3600 * 1000 },
  { key: '3h', ms: 3 * 3600 * 1000 },
  { key: '15m', ms: 15 * 60 * 1000 },
];

const TYPE_TO_KEY: Record<string, string> = { MATCH_WINNER: 'h2h', OVER_UNDER: 'totals', HANDICAP: 'spreads' };

export async function runRefreshEplOddsCheckpointsJob() {
  const timestamp = new Date().toISOString();
  try {
    const allMarkets = await prisma.market.findMany({
      include: { selections: true, game: true },
    });
    const markets = allMarkets.filter(
      (m) => m.sourceBookmakerKeys != null && (m.game as { externalEventId: string | null } | null)?.externalEventId != null
    );

    const gameMap = new Map<string, { game: { id: string; externalEventId: string; startTime: Date }; mkt: (typeof markets[0])[] }>();
    for (const m of markets) {
      const g = m.game as { id: string; externalEventId: string | null; startTime: Date; status: string } | null;
      if (!g?.externalEventId) continue;
      // Only refresh odds for games that are upcoming or live (never finished/cancelled/postponed)
      if (!['SCHEDULED', 'LIVE', 'SUSPENDED'].includes(g.status)) continue;
      // Skip games whose kickoff has already passed (event likely expired)
      if (new Date(g.startTime).getTime() <= Date.now()) continue;
      const existing = gameMap.get(g.id) ?? { game: { id: g.id, externalEventId: g.externalEventId, startTime: g.startTime }, mkt: [] };
      existing.mkt.push(m);
      gameMap.set(g.id, existing);
    }

    let gamesChecked = 0;
    let marketsUpdated = 0;
    let checkpointsRecorded = 0;
    let fetchErrors = 0;

    for (const [, entry] of gameMap) {
      const now = new Date();
      const startTime = new Date(entry.game.startTime);
      const extId = entry.game.externalEventId;

      // Determine which checkpoints need to fire now
      const neededCheckpoints: string[] = [];
      for (const cp of CHECKPOINTS) {
        const checkpointTime = new Date(startTime.getTime() - cp.ms);
        if (now >= checkpointTime) {
          // Check if already recorded
          const existing = await prisma.oddsFetchCheckpoint.findUnique({
            where: { gameId_checkpoint: { gameId: entry.game.id, checkpoint: cp.key } },
          });
          if (!existing) neededCheckpoints.push(cp.key);
        }
      }

      if (neededCheckpoints.length === 0) continue;

      gamesChecked++;

      // Fetch fresh JSON once for all checkpoints in this tick
      let freshRaw: unknown;
      try {
        await eplGameOdds.fetchAndSaveGameOdds(extId);
        freshRaw = eplGameOdds.readGameOdds(extId);
      } catch {
        fetchErrors++;
        continue;
      }
      if (!freshRaw) continue;

      const groups = eplGameOdds.groupOdds(freshRaw);
      const groupsByKey = new Map(groups.map((g) => [`${g.marketKey}::${g.point ?? 'null'}`, g]));

      for (const m of entry.mkt) {
        const sKeys = m.sourceBookmakerKeys as string[] | null;
        if (!sKeys?.length) continue;
        const bookmakerKey = sKeys[0];
        const params = m.parameters as { marketKey?: string; line?: number | null } | null;
        const marketKey = (typeof params?.marketKey === 'string' && params.marketKey) || TYPE_TO_KEY[m.type] || null;
        if (!marketKey) continue;
        const point = params?.line ?? null;
        const groupKey = `${marketKey}::${point ?? 'null'}`;
        const group = groupsByKey.get(groupKey);
        if (!group) continue;

        const bm = group.bookmakers.find((b) => b.bookmakerKey === bookmakerKey);
        if (!bm) continue;

        for (const sel of m.selections) {
          const outcome = bm.outcomes.find((o) => o.name === sel.name);
          if (!outcome) continue;
          if (Number(outcome.price) === Number(sel.odds)) continue;

          await prisma.selection.update({ where: { id: sel.id }, data: { odds: outcome.price } });
          await prisma.oddsHistory.create({ data: { selectionId: sel.id, odds: outcome.price } });
          marketsUpdated++;
        }

        await prisma.market.update({ where: { id: m.id }, data: { lastSourceCheckedAt: new Date() } });
      }

      // Record checkpoints
      for (const cpKey of neededCheckpoints) {
        await prisma.oddsFetchCheckpoint.create({
          data: { gameId: entry.game.id, checkpoint: cpKey, fetchedAt: new Date() },
        });
        checkpointsRecorded++;
      }
    }

    console.log(
      `[refresh-epl-odds-checkpoints] ${timestamp} - games ${gamesChecked}, markets updated ${marketsUpdated}, checkpoints recorded ${checkpointsRecorded}, fetch errors ${fetchErrors}`
    );
    return { gamesChecked, marketsUpdated, checkpointsRecorded, fetchErrors };
  } catch (err) {
    console.error(`[refresh-epl-odds-checkpoints] ${timestamp} - failed:`, err instanceof Error ? err.message : String(err));
    return { gamesChecked: 0, marketsUpdated: 0, checkpointsRecorded: 0, fetchErrors: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export default runRefreshEplOddsCheckpointsJob;