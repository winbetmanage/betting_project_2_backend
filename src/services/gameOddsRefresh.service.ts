import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import { getOddsApiEventDetailUrl } from '../../codes';
import { resolveSportKey } from './bookmakerOdds.service';

type RawOutcome = { name: string; price: number; point?: number | null };
type RawMarket = { key: string; last_update?: string; outcomes?: RawOutcome[] };
type RawBookmaker = { key: string; title?: string; markets?: RawMarket[] };
type RawEvent = { id?: string; bookmakers?: RawBookmaker[] };

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** market type → odds-api market key fallback (when parameters.marketKey is missing) */
const TYPE_TO_KEY: Record<string, string> = {
  MATCH_WINNER: 'h2h',
  OVER_UNDER: 'totals',
  HANDICAP: 'spreads',
  BOTH_TEAMS_TO_SCORE: 'btts',
  CORRECT_SCORE: 'correct_score',
};

const FREE_PLAN_KEYS = new Set(['h2h', 'totals', 'spreads']);

export function marketKeyOf(market: { type: string; parameters: unknown }): string | null {
  const params = (market.parameters ?? {}) as { marketKey?: unknown };
  if (typeof params.marketKey === 'string' && params.marketKey) return params.marketKey;
  return TYPE_TO_KEY[market.type] ?? null;
}

/** Fetch one event's odds for exactly the given market keys (fallback list on 422). */
async function fetchEventOdds(sportKey: string, eventId: string, marketKeys: string[]): Promise<RawEvent> {
  const tryLists = [marketKeys.join(','), marketKeys.filter((k) => FREE_PLAN_KEYS.has(k)).join(',')];
  let lastErr = '';
  for (const markets of tryLists) {
    if (!markets) continue;
    const res = await fetch(getOddsApiEventDetailUrl(sportKey, eventId, markets));
    if (res.ok) {
      const data = (await res.json()) as RawEvent | RawEvent[];
      const ev = Array.isArray(data) ? data.find((e) => e?.id === eventId) ?? data[0] : data;
      if (!ev) throw new ApiError(502, 'odds-api returned no event');
      return ev;
    }
    const text = await res.text().catch(() => '');
    lastErr = `${res.status} ${text.slice(0, 160)}`;
    // only retry with narrower market list on plan/market rejection
    if (res.status !== 400 && res.status !== 422) break;
  }
  throw new ApiError(502, `odds fetch failed: ${lastErr}`);
}

export type GameOddsRefreshResult = {
  gameId: string;
  eventId: string;
  marketsChecked: number;
  marketsUpdated: number;
  oddsChanged: number;
  skippedNoSource: number;
  appliedKeys: string[];
  notes: string[];
};

/**
 * Refresh Selection.odds for ONE game, using only the market keys its OPEN markets
 * use and only each market's own approved source bookmaker(s).
 * Always advances Game.lastOddsFetchAt (success or final failure) when `touch`.
 */
export async function refreshGameOdds(gameId: string, touch = true): Promise<GameOddsRefreshResult> {
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: {
      competition: { select: { name: true } },
      markets: { where: { status: 'OPEN' }, include: { selections: true } },
    },
  });
  if (!game) throw new ApiError(404, 'Game not found');
  if (!game.externalEventId) throw new ApiError(400, 'Game has no externalEventId');

  const notes: string[] = [];
  const usable = game.markets.filter((m) => marketKeyOf(m) !== null);
  const marketKeys = [...new Set(usable.map((m) => marketKeyOf(m) as string))];

  const finish = async (partial: Omit<GameOddsRefreshResult, 'notes'> & { notes: string[] }) => {
    if (touch) await prisma.game.update({ where: { id: gameId }, data: { lastOddsFetchAt: new Date() } });
    return partial;
  };

  if (marketKeys.length === 0) {
    return finish({ gameId, eventId: game.externalEventId, marketsChecked: 0, marketsUpdated: 0, oddsChanged: 0, skippedNoSource: 0, appliedKeys: [], notes: ['no supported open markets'] });
  }

  const sportKey = resolveSportKey(game);
  let ev: RawEvent;
  try {
    ev = await fetchEventOdds(sportKey, game.externalEventId, marketKeys);
  } catch (e) {
    // still advance the timestamp so a broken game waits for the next interval
    if (touch) await prisma.game.update({ where: { id: gameId }, data: { lastOddsFetchAt: new Date() } });
    throw e;
  }

  const bookmakers = Array.isArray(ev.bookmakers) ? ev.bookmakers : [];
  let marketsChecked = 0;
  let marketsUpdated = 0;
  let oddsChanged = 0;
  let skippedNoSource = 0;
  const appliedKeys = new Set<string>();

  for (const market of usable) {
    const key = marketKeyOf(market) as string;
    const sources = Array.isArray(market.sourceBookmakerKeys) ? (market.sourceBookmakerKeys as unknown[]).filter((k): k is string => typeof k === 'string') : [];
    if (sources.length === 0) {
      skippedNoSource++;
      continue;
    }
    const params = (market.parameters ?? {}) as { line?: unknown };
    const line = typeof params.line === 'number' ? params.line : null;

    // find the market entry with a matching point/line among the source bookmakers
    let outcomes: RawOutcome[] | null = null;
    for (const bm of bookmakers) {
      if (!sources.includes(bm.key)) continue;
      const candidates = (bm.markets ?? []).filter((m) => m.key === key);
      for (const cm of candidates) {
        const opts = cm.outcomes ?? [];
        if (line == null) {
          if (opts.length) { outcomes = opts; break; }
        } else {
          const matching = opts.filter((o) => o.point === line);
          if (matching.length) { outcomes = matching; break; }
        }
      }
      if (outcomes) break;
    }
    marketsChecked++;
    if (!outcomes) {
      notes.push(`market "${market.name}" (${key}${line != null ? ` line ${line}` : ''}) not found from source(s) ${sources.join('/')}`);
      continue;
    }

    appliedKeys.add(key);
    const priceByName = new Map<string, number>();
    for (const o of outcomes) priceByName.set(norm(o.name), Number(o.price));

    let marketChanged = 0;
    for (const sel of market.selections) {
      const price = priceByName.get(norm(sel.name));
      if (price == null || !Number.isFinite(price) || price <= 1) continue;
      if (Math.abs(Number(sel.odds) - price) < 0.0005) continue;
      await prisma.selection.update({ where: { id: sel.id }, data: { odds: price } });
      await prisma.oddsHistory.create({ data: { selectionId: sel.id, odds: price } });
      oddsChanged++;
      marketChanged++;
    }
    if (marketChanged > 0) marketsUpdated++;
  }

  return finish({ gameId, eventId: game.externalEventId, marketsChecked, marketsUpdated, oddsChanged, skippedNoSource, appliedKeys: [...appliedKeys], notes });
}
