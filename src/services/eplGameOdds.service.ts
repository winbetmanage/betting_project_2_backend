import fs from 'fs';
import path from 'path';
import ApiError from '../utils/ApiError';
import { getAllMarketsOddsUrl, getOddsApiEventAllMarketsUrl, getOddsApiEventDetailUrl, getEventMarketsUrl, ODDS_API_ALL_MARKETS } from '../../codes';

export type BookmakerGroup = {
  marketKey: string;
  label: string;
  point: number | null;
  bookmakers: {
    bookmakerKey: string;
    last_update: string;
    outcomes: { name: string; price: number; point?: number | null }[];
  }[];
  count: number;
  warning: boolean;
};

type RawOutcome = { name: string; price: number; point?: number };
type RawMarket = { key: string; last_update?: string; outcomes?: RawOutcome[] };
type RawBookmaker = { key: string; title?: string; last_update?: string; markets?: RawMarket[] };

function gamesOddsDir(): string {
  const dirs = [
    path.join(process.cwd(), 'epl_games_odds'),
    path.join(process.cwd(), 'Back-end', 'epl_games_odds'),
    path.join(process.cwd(), 'dist', 'epl_games_odds'),
  ];
  for (const d of dirs) {
    if (fs.existsSync(d)) return d;
  }
  const primary = path.join(process.cwd(), 'epl_games_odds');
  fs.mkdirSync(primary, { recursive: true });
  return primary;
}

export function jsonPathFor(externalEventId: string): string {
  return path.join(gamesOddsDir(), `${externalEventId}.json`);
}

export function hasJsonFor(externalEventId: string): boolean {
  return fs.existsSync(jsonPathFor(externalEventId));
}

// Market-set ladder: featured-markets default first (the only keys the bulk
// endpoint supports), then progressively narrower sets in case the API plan
// rejects a key (The Odds API 422s the entire request if ANY requested market
// is not on the plan).
const MARKET_LADDER: (string | undefined)[] = [undefined, "h2h,totals", "h2h"];

async function fetchOddsEvents(sportKey: string): Promise<{ events: { id?: string; bookmakers?: unknown[] }[]; marketsUsed: string }> {
  let lastErr: ApiError | null = null;
  for (const mkts of MARKET_LADDER) {
    const url = getAllMarketsOddsUrl(sportKey, mkts);
    if (!url.includes("apiKey=") || url.includes("apiKey=undefined")) {
      throw new ApiError(500, "API key not configured (API_ONE)");
    }
    let res: Response;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new ApiError(502, `Odds request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.ok) {
      const data = await res.json();
      if (!Array.isArray(data)) throw new ApiError(500, "Invalid odds response (expected an array of events)");
      return { events: data as { id?: string; bookmakers?: unknown[] }[], marketsUsed: mkts ?? "featured" };
    }
    const text = await res.text().catch(() => "");
    const err = new ApiError(res.status, `Failed to fetch game odds: ${res.status} ${text.slice(0, 300)}`);
    // Only retry on plan/market-rejection status codes; anything else is fatal
    if (res.status === 400 || res.status === 422 || /market/i.test(text)) {
      lastErr = err;
      continue;
    }
    throw err;
  }
  throw lastErr ?? new ApiError(500, "Odds fetch failed");
}

export async function fetchAndSaveGameOdds(externalEventId: string, sportKey: string = "soccer_epl"): Promise<number> {
  const { events, marketsUsed } = await fetchOddsEvents(sportKey);
  const event = events.find((e) => e?.id === externalEventId);
  if (!event) throw new ApiError(404, `Event ${externalEventId} is not present in the current odds feed for ${sportKey} (${marketsUsed} markets)`);
  const file = jsonPathFor(externalEventId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(event, null, 2), "utf-8");
  const bmCount = Array.isArray(event.bookmakers) ? event.bookmakers.length : 0;
  console.log(`[eplGameOdds] saved ${file} using markets=${marketsUsed} (${bmCount} bookmakers)`);
  return bmCount;
}

/** Which market keys the books actually offer for one event (null = unknown). */
export async function fetchSupportedKeys(sportKey: string, eventId: string): Promise<Set<string> | null> {
  try {
    const res = await fetch(getEventMarketsUrl(sportKey, eventId));
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const keys = new Set<string>();
    const collect = (m: unknown) => {
      if (typeof m === 'string' && m) keys.add(m.toLowerCase());
      else if (m && typeof m === 'object' && typeof (m as { key?: unknown }).key === 'string') {
        keys.add(((m as { key: string }).key).toLowerCase());
      }
    };
    const root = data as { bookmakers?: unknown; markets?: unknown };
    const bms = Array.isArray(data) ? data : root.bookmakers ?? root.markets;
    if (Array.isArray(bms)) {
      for (const b of bms) {
        const inner = (b as { markets?: unknown }).markets;
        if (Array.isArray(inner)) inner.forEach(collect);
        else collect(b);
      }
    }
    return keys.size > 0 ? keys : null;
  } catch {
    return null;
  }
}

type RawEvent = { id?: string; bookmakers?: RawBookmaker[] };

async function fetchEventAll(sportKey: string, eventId: string): Promise<{ event: RawEvent; marketsUsed: string }> {
  // 1. ALL markets in one per-event call
  let res = await fetch(getOddsApiEventAllMarketsUrl(sportKey, eventId));
  if (res.ok) {
    const data = (await res.json()) as RawEvent | RawEvent[];
    const ev = Array.isArray(data) ? data.find((e) => e?.id === eventId) ?? data[0] : data;
    if (!ev) throw new ApiError(502, 'odds-api returned no event');
    return { event: ev, marketsUsed: 'all' };
  }
  const firstErr = `${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`;
  if (res.status !== 400 && res.status !== 422) {
    throw new ApiError(res.status, `Failed to fetch event odds: ${firstErr}`);
  }
  // 2. only the keys the books actually offer for this event
  const supported = await fetchSupportedKeys(sportKey, eventId);
  if (supported) {
    const subset = ODDS_API_ALL_MARKETS.split(',').filter((k) => supported.has(k.toLowerCase()));
    if (subset.length > 0) {
      res = await fetch(getOddsApiEventDetailUrl(sportKey, eventId, subset.join(',')));
      if (res.ok) {
        const data = (await res.json()) as RawEvent | RawEvent[];
        const ev = Array.isArray(data) ? data.find((e) => e?.id === eventId) ?? data[0] : data;
        if (!ev) throw new ApiError(502, 'odds-api returned no event');
        return { event: ev, marketsUsed: `supported(${subset.length})` };
      }
    }
  }
  // 3. last resort: featured markets only (same as the bulk feed)
  res = await fetch(getOddsApiEventDetailUrl(sportKey, eventId, 'h2h,spreads,totals'));
  if (!res.ok) {
    throw new ApiError(502, `odds fetch failed: ${firstErr} | ${(await res.text().catch(() => '')).slice(0, 160)}`);
  }
  const data = (await res.json()) as RawEvent | RawEvent[];
  const ev = Array.isArray(data) ? data.find((e) => e?.id === eventId) ?? data[0] : data;
  if (!ev) throw new ApiError(502, 'odds-api returned no event');
  return { event: ev, marketsUsed: 'featured' };
}

/**
 * Per-event "fetch all-market odds": requests ODDS_API_ALL_MARKETS for one event
 * and saves the payload to epl_games_odds/<eventId>.json (used by the admin
 * "fetch all-market odds" button). Falls back to the supported subset, then
 * featured markets, so it never 422s fatally.
 */
export async function fetchAndSaveEventOdds(externalEventId: string, sportKey: string = "soccer_epl"): Promise<number> {
  const { event, marketsUsed } = await fetchEventAll(sportKey, externalEventId);
  const file = jsonPathFor(externalEventId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(event, null, 2), "utf-8");
  const bmCount = Array.isArray(event.bookmakers) ? event.bookmakers.length : 0;
  console.log(`[eplGameOdds] saved ${file} using markets=${marketsUsed} (${bmCount} bookmakers)`);
  return bmCount;
}

export function getGameOddsFileInfo(externalEventId: string): { bookmakerCount: number; marketCount: number; updatedAt: Date | null; path: string } | null {
  const file = jsonPathFor(externalEventId);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { bookmakers?: { markets?: { key?: string }[] }[] };
    const bookmakers = parsed.bookmakers ?? [];
    const marketKeys = new Set<string>();
    for (const b of bookmakers) for (const m of b.markets ?? []) if (m.key) marketKeys.add(m.key);
    let updatedAt: Date | null = null;
    try {
      updatedAt = fs.statSync(file).mtime;
    } catch {
      /* ignore */
    }
    return { bookmakerCount: bookmakers.length, marketCount: marketKeys.size, updatedAt, path: file };
  } catch {
    return null;
  }
}

export function readGameOdds(externalEventId: string): unknown | null {
  const file = jsonPathFor(externalEventId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function humanLabel(marketKey: string, point: number | null): string {
  const known: Record<string, string> = {
    h2h: 'Match Winner',
    totals: 'Totals',
    spreads: 'Spreads',
    h2h_3_way: 'Match Winner (3-Way)',
    btts: 'Both Teams to Score',
    draw_no_bet: 'Draw No Bet',
    double_chance: 'Double Chance',
    h2h_h1: 'First Half Winner',
    h2h_h2: 'Second Half Winner',
    totals_h1: 'First Half Totals',
    totals_h2: 'Second Half Totals',
    btts_h1: 'First Half BTTS',
    double_chance_h1: 'First Half Double Chance',
    correct_score: 'Correct Score',
    correct_score_h1: 'First Half Correct Score',
    halftime_fulltime: 'Half-Time/Full-Time',
    team_totals: 'Team Totals',
    alternate_spreads: 'Alternate Spreads',
    alternate_totals: 'Alternate Totals',
    alternate_team_totals: 'Alternate Team Totals',
    corners_1x2: 'Corners 1X2',
    alternate_totals_corners: 'Alternate Corner Totals',
    alternate_spreads_corners: 'Alternate Corner Spreads',
    alternate_totals_cards: 'Alternate Card Totals',
    alternate_spreads_cards: 'Alternate Card Spreads',
  };
  const base = known[marketKey] ?? marketKey.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  if (point != null) return `${base} — line ${point}`;
  return base;
}

export function groupOdds(raw: unknown): BookmakerGroup[] {
  const data = raw as { bookmakers?: RawBookmaker[] } | null;
  const bookmakers = data?.bookmakers ?? [];
  type Group = BookmakerGroup;
  const map = new Map<string, Group>();

  const ensureGroup = (marketKey: string, point: number | null, bmKey: string, marketLastUpdate?: string, bmLastUpdate?: string): Group => {
    const pointKey = point != null ? String(point) : 'null';
    const groupKey = `${marketKey}::${pointKey}`;
    let group = map.get(groupKey);
    if (!group) {
      const label = humanLabel(marketKey, point);
      group = { marketKey, label, point, bookmakers: [], count: 0, warning: false };
      map.set(groupKey, group);
    }
    let bmEntry = group.bookmakers.find((b) => b.bookmakerKey === bmKey);
    if (!bmEntry) {
      bmEntry = { bookmakerKey: bmKey, last_update: marketLastUpdate ?? bmLastUpdate ?? new Date().toISOString(), outcomes: [] };
      group.bookmakers.push(bmEntry);
    }
    const mu = marketLastUpdate ?? bmLastUpdate ?? '';
    if (mu && new Date(mu) > new Date(bmEntry.last_update)) bmEntry.last_update = mu;
    return group;
  };

  for (const bm of bookmakers) {
    const bmKey = bm.key ?? 'unknown';
    const bmLastUpdate = bm.last_update ?? new Date().toISOString();
    for (const market of bm.markets ?? []) {
      const outcomes = market.outcomes ?? [];
      if (outcomes.length === 0) continue;

      // Split outcomes by point so each line (1.5, 2.5, ...) is its own selectable market
      const byPoint = new Map<string, RawOutcome[]>();
      for (const o of outcomes) {
        const pk = o.point != null ? String(o.point) : 'null';
        if (!byPoint.has(pk)) byPoint.set(pk, []);
        byPoint.get(pk)!.push(o);
      }

      for (const [pk, ptOutcomes] of byPoint) {
        const point = pk === 'null' ? null : Number(pk);
        const group = ensureGroup(market.key, point, bmKey, market.last_update, bmLastUpdate);
        const bmEntry = group.bookmakers.find((b) => b.bookmakerKey === bmKey)!;
        for (const o of ptOutcomes) {
          bmEntry.outcomes.push({ name: o.name, price: o.price, point: o.point ?? null });
        }
      }
    }
  }

  const groups = Array.from(map.values()).map((g) => ({
    ...g,
    bookmakers: g.bookmakers.sort((a, b) => a.bookmakerKey.localeCompare(b.bookmakerKey)),
    count: g.bookmakers.length,
    warning: g.bookmakers.length === 1,
  }));

  groups.sort((a, b) => {
    const al = a.label.toLowerCase();
    const bl = b.label.toLowerCase();
    if (al < bl) return -1;
    if (al > bl) return 1;
    if (a.point != null && b.point != null) return a.point - b.point;
    return 0;
  });

  return groups;
}
