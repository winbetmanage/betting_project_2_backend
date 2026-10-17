import fs from 'fs';
import path from 'path';
import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import type { Prisma } from '@prisma/client';
import * as eplGameOdds from './eplGameOdds.service';
import { resolveSportKey } from './bookmakerOdds.service';
import { resolveMarketType, humanLabel } from './marketApproval.service';
import * as betService from './bet.service';

/**
 * Market replacement.
 *
 * The odds API sometimes hands back a bad market for a game (wrong team names, a
 * stale bookmaker, the wrong line). A recorded Market cannot be deleted once
 * anybody has bet on it — `BetSelection -> Selection` has no ON DELETE CASCADE,
 * so the row is structurally pinned in place. `removeMarket` therefore throws
 * for every bet market that has ever been touched.
 *
 * `replaceMarket` takes the other route: it builds the corrected market from a
 * different bookmaker/line of the *same* market key, then repoints every bet leg
 * at the new selection. The old market is never deleted — it is cancelled and
 * tagged with `parameters.replacedByMarketId`, so it stays as the audit record
 * and as the anchor for legs the admin chose to void.
 *
 * The admin picks one of four actions per old selection:
 *   match  -> repoint the leg at a named outcome of the new market, and either
 *             take the new odds (default) or keep the old odds
 *   keep   -> carry the old name/odds across as an extra selection
 *   void   -> mark the legs VOID (refunds when every leg ends up void)
 *   block  -> refuse the whole replacement, nothing is written
 */

// ---------------------------------------------------------------------------
// Name matching
// ---------------------------------------------------------------------------

/** Generic legal-form tokens that carry no club identity. */
const CLUB_NOISE = new Set([
  'fc', 'afc', 'cf', 'sc', 'ac', 'as', 'ssc', 'cd', 'ca', 'sd', 'sk', 'fk', 'bk',
  'if', 'ik', 'aik', 'tsg', 'bsc', 'vfl', 'vfb', 'sv', 'fs', 'tsv', 'mks', 'us',
  'uscfc', 'the', 'calcio', 'club', 'de', 'of', '1899', '1900', '1846',
]);

export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function nameTokens(value: string): string[] {
  return normalizeName(value).split(' ').filter((t) => t.length > 0 && !CLUB_NOISE.has(t));
}

export type NameScore = { score: number; reason: string };

/**
 * How likely two outcome labels refer to the same thing. 1 = certain,
 * 0 = no relationship. Deliberately generous: the admin reviews every
 * suggestion, so a loose hint beats silently dropping somebody's pick.
 */
export function scoreNames(a: string, b: string, anchors: string[] = []): NameScore {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return { score: 0, reason: 'empty name' };
  if (na === nb) return { score: 1, reason: 'exact name' };
  // The game itself knows the two clubs — an exact hit on either is certain.
  for (const anchor of anchors) {
    const nAnchor = normalizeName(anchor);
    if (nAnchor === na || nAnchor === nb) return { score: 1, reason: "matches this game's team" };
  }

  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length && tb.length) {
    const sa = new Set(ta);
    const sb = new Set(tb);
    if (ta.length === tb.length && ta.every((t) => sb.has(t))) return { score: 0.95, reason: 'same words' };
    if (ta.every((t) => sb.has(t)) || tb.every((t) => sa.has(t))) return { score: 0.8, reason: 'one name contains the other' };
    const shared = ta.filter((t) => sb.has(t)).length;
    if (shared > 0) {
      const ratio = shared / Math.max(ta.length, tb.length);
      return { score: Math.min(0.85, 0.45 + ratio * 0.4), reason: 'shared words' };
    }
  }
  if (na.replace(/ /g, '') === nb.replace(/ /g, '')) return { score: 0.9, reason: 'same letters' };
  return { score: 0, reason: 'no match' };
}

/** Below this the admin must confirm the pairing themselves. */
const MIN_AUTO_MATCH = 0.45;

/**
 * Greedy best-first 1:1 assignment. Sorting by score means an exact hit claims
 * its slot before a looser guess can steal it — "Manchester United" wins over
 * "Manchester City", which merely shares the word "Manchester".
 */
function autoMatch(
  olds: { id: string; name: string }[],
  news: { name: string }[],
  anchors: string[]
): Map<string, { outcomeName: string; score: number; reason: string }> {
  const pairs: { oldId: string; outcomeName: string; score: number; reason: string }[] = [];
  for (const o of olds) {
    for (const n of news) {
      const { score, reason } = scoreNames(o.name, n.name, anchors);
      if (score >= MIN_AUTO_MATCH) pairs.push({ oldId: o.id, outcomeName: n.name, score, reason });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const takenOld = new Set<string>();
  const takenNew = new Set<string>();
  const out = new Map<string, { outcomeName: string; score: number; reason: string }>();
  for (const p of pairs) {
    if (takenOld.has(p.oldId) || takenNew.has(p.outcomeName)) continue;
    takenOld.add(p.oldId);
    takenNew.add(p.outcomeName);
    out.set(p.oldId, { outcomeName: p.outcomeName, score: p.score, reason: p.reason });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Candidate discovery (read straight from the saved odds-api JSON)
// ---------------------------------------------------------------------------

export type ReplaceOutcome = { name: string; odds: number };

export type ReplaceCandidate = {
  key: string;
  marketKey: string;
  point: number | null;
  label: string;
  bookmakerKey: string;
  lastUpdate: string | null;
  outcomes: ReplaceOutcome[];
};

const candidateKey = (marketKey: string, point: number | null, bookmakerKey: string): string =>
  `${marketKey}::${point ?? 'null'}::${bookmakerKey}`;

type MarketParams = { marketKey?: string; line?: number | null; replacedByMarketId?: string } | null;

const paramsOf = (market: { parameters: unknown }): MarketParams =>
  (market.parameters ?? null) as MarketParams;

let ALL_MARKET_KEYS: string[] = [];

function allMarketKeys(): string[] {
  if (ALL_MARKET_KEYS.length) return ALL_MARKET_KEYS;
  const candidates = [
    path.join(__dirname, '..', 'config', 'marketTypes.json'),
    path.join(process.cwd(), 'src', 'config', 'marketTypes.json'),
  ];
  for (const f of candidates) {
    try {
      if (!fs.existsSync(f)) continue;
      const raw = JSON.parse(fs.readFileSync(f, 'utf-8')) as Record<string, unknown>;
      ALL_MARKET_KEYS = Object.keys(raw).filter((k) => !k.startsWith('_'));
      if (ALL_MARKET_KEYS.length) return ALL_MARKET_KEYS;
    } catch {
      /* try the next location */
    }
  }
  ALL_MARKET_KEYS = ['h2h', 'h2h_3_way', 'totals', 'spreads', 'btts', 'double_chance', 'draw_no_bet', 'correct_score'];
  return ALL_MARKET_KEYS;
}

/**
 * Substitutable variants of one underlying market. "Match Winner (Lay)" and
 * "Match Winner" are the same market wearing different labels — they even grade
 * the same way (marketSettlement.json: both `match_winner` / FT) — so replacing
 * one with the other must be offered, and the bets carry across club for club.
 * Deliberately NOT widened to other keys of the same MarketType: `h2h_3_way` or
 * `draw_no_bet` are different markets, and a lay price is not a back price.
 */
const MARKET_KEY_FAMILY: Record<string, string[]> = {
  h2h: ['h2h_lay'],
  h2h_lay: ['h2h'],
  double_chance: ['double_chance_lay'],
  double_chance_lay: ['double_chance'],
};

export const isSiblingMarketKey = (from: string, to: string): boolean => (MARKET_KEY_FAMILY[from] ?? []).includes(to);

/** The market key this market came from; falls back to a type-wide match. */
function targetMarketKeys(market: { type: string; parameters: unknown }): string[] {
  const key = paramsOf(market)?.marketKey;
  // Its own key first, then the variants that may stand in for it.
  if (key) return [key, ...(MARKET_KEY_FAMILY[key] ?? [])];
  // Manually created market: every odds-api key that resolves to the same type.
  return allMarketKeys().filter((k) => resolveMarketType(k) === market.type);
}

/** Every bookmaker's version of the given market keys. */
function collectCandidatesForKeys(externalEventId: string, keys: string[]): ReplaceCandidate[] {
  const raw = eplGameOdds.readGameOdds(externalEventId);
  if (!raw) return [];
  const keySet = new Set(keys);
  const out: ReplaceCandidate[] = [];
  for (const g of eplGameOdds.groupOdds(raw)) {
    if (!keySet.has(g.marketKey)) continue;
    for (const bm of g.bookmakers) {
      const seen = new Set<string>();
      const outcomes: ReplaceOutcome[] = [];
      for (const o of bm.outcomes) {
        const odds = Number(o.price);
        if (!Number.isFinite(odds) || odds <= 1) continue;
        const dedupe = o.name.trim().toLowerCase();
        if (!dedupe || seen.has(dedupe)) continue;
        seen.add(dedupe);
        outcomes.push({ name: o.name, odds });
      }
      if (outcomes.length === 0) continue;
      out.push({
        key: candidateKey(g.marketKey, g.point, bm.bookmakerKey),
        marketKey: g.marketKey,
        point: g.point,
        label: humanLabel(g.marketKey, g.point),
        bookmakerKey: bm.bookmakerKey,
        lastUpdate: bm.last_update ?? null,
        outcomes,
      });
    }
  }
  return out;
}

/** Every bookmaker's version of the markets this one could be replaced with. */
function collectCandidates(
  externalEventId: string,
  market: { type: string; parameters: unknown }
): ReplaceCandidate[] {
  return collectCandidatesForKeys(externalEventId, targetMarketKeys(market));
}

const loadMarketOrThrow = async (marketId: string) => {
  const market = await prisma.market.findUnique({
    where: { id: marketId },
    include: {
      selections: {
        include: { betSelections: { include: { bet: { select: { id: true, status: true, userId: true } } } } },
      },
    },
  });
  if (!market) throw new ApiError(404, 'Market not found');
  return market;
};

async function loadGameForMarket(marketId: string) {
  const market = await loadMarketOrThrow(marketId);
  if (!market.gameId) throw new ApiError(400, 'Market is not attached to a game');
  if (market.status === 'SETTLED') throw new ApiError(400, 'Settled markets cannot be replaced');
  const game = await prisma.game.findUnique({
    where: { id: market.gameId },
    include: { competition: { select: { name: true } } },
  });
  if (!game) throw new ApiError(404, 'Game not found');
  if (!game.externalEventId) {
    throw new ApiError(400, 'This game has no odds-api event id — fetch its markets before replacing one');
  }
  return { market, game };
}

/**
 * The saved odds file is whatever the last fetch returned, so it can predate a
 * market key entirely — a lay market recorded by hand, or a sibling key such as
 * plain `h2h` when only the lay variant was ever pulled. Rather than telling the
 * admin nothing can replace it, refresh once and read the file again. A failed
 * fetch is not fatal: whatever is on disk is still usable.
 */
async function refreshOddsFile(externalEventId: string, game: { specifications?: unknown; competition?: { name?: string | null } | null }): Promise<boolean> {
  try {
    const sportKey = resolveSportKey(game as Parameters<typeof resolveSportKey>[0]);
    const bookmakers = await eplGameOdds.fetchAndSaveEventOdds(externalEventId, sportKey, { minimal: false });
    return bookmakers > 0;
  } catch (e) {
    console.warn(`[marketReplace] odds refresh failed for ${externalEventId}:`, e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * Resolve the chosen candidate, pulling fresh odds once if the saved file does
 * not have it — the file is only as complete as the last fetch, so a substitutable
 * key (a lay market swapped for the standard one) may simply not be in it yet.
 */
async function resolveCandidate(
  externalEventId: string,
  game: { specifications?: unknown; competition?: { name?: string | null } | null },
  market: { type: string; parameters: unknown },
  key: string
): Promise<ReplaceCandidate> {
  let found = collectCandidates(externalEventId, market).find((c) => c.key === key);
  if (found) return found;
  if (await refreshOddsFile(externalEventId, game)) {
    found = collectCandidates(externalEventId, market).find((c) => c.key === key);
    if (found) return found;
  }
  throw new ApiError(400, 'That replacement market is not available from the odds api — refetch and pick another one');
}

// ---------------------------------------------------------------------------
// 1. Options
// ---------------------------------------------------------------------------

export type ReplaceCandidateRow = ReplaceCandidate & {
  /** A different market key than the one being replaced (e.g. lay -> standard). */
  siblingKey: boolean;
  /**
   * A market on this game already covers this key + line, so the bets merge
   * into it instead of a duplicate being created. Null = create a new market.
   */
  mergeInto: { id: string; name: string; status: string } | null;
};

export type ReplaceOptions = {
  market: {
    id: string;
    name: string;
    type: string;
    status: string;
    marketKey: string | null;
    line: number | null;
    betCount: number;
    bettorCount: number;
    sourceBookmakerKeys: string[];
    selections: { id: string; name: string; odds: number; betLegs: number }[];
  };
  candidates: ReplaceCandidateRow[];
  refreshed: boolean;
  source: { bookmakerCount: number; marketCount: number; updatedAt: string | null } | null;
  noSource: boolean;
};

export async function getReplaceOptions(marketId: string): Promise<ReplaceOptions> {
  const { market, game } = await loadGameForMarket(marketId);
  const params = paramsOf(market);
  const legs = market.selections.flatMap((s) => s.betSelections);

  // The saved file may not carry a substitutable key yet (a hand-made lay
  // market, or a sibling key the last fetch never asked for). Pull fresh odds
  // once so "Match Winner" is genuinely available for a lay market.
  let all = collectCandidates(game.externalEventId!, market);
  let refreshed = false;
  if (all.length === 0) {
    refreshed = await refreshOddsFile(game.externalEventId!, game);
    if (refreshed) all = collectCandidates(game.externalEventId!, market);
  }

  // A (marketKey, line) already recorded on this game is merged into rather than
  // duplicated — that is how a lay market's bets reach an existing Match Winner.
  const siblings = await prisma.market.findMany({ where: { gameId: game.id } });
  const activeByKey = new Map<string, { id: string; name: string; status: string }>();
  for (const m of siblings) {
    const p = paramsOf(m);
    const key = `${p?.marketKey ?? m.type}::${p?.line ?? 'null'}`;
    // A retired market shares its key+line with the successor that took over,
    // so only a market that is still in play counts as "already recorded".
    if (m.status !== 'CANCELLED' || !activeByKey.has(key)) activeByKey.set(key, { id: m.id, name: m.name, status: m.status });
  }

  const ownKey = params?.marketKey ?? null;
  const candidates: ReplaceCandidateRow[] = all.map((c) => {
    const hit = activeByKey.get(`${c.marketKey}::${c.point ?? 'null'}`);
    return {
      ...c,
      siblingKey: !!ownKey && c.marketKey !== ownKey,
      mergeInto: hit && hit.id !== market.id ? { id: hit.id, name: hit.name, status: hit.status } : null,
    };
  });

  const byBookmakerThenLine = (a: ReplaceCandidate, b: ReplaceCandidate) =>
    a.bookmakerKey.localeCompare(b.bookmakerKey) ||
    (a.point ?? 0) - (b.point ?? 0) ||
    a.label.localeCompare(b.label);

  const info = eplGameOdds.getGameOddsFileInfo(game.externalEventId!);

  return {
    market: {
      id: market.id,
      name: market.name,
      type: market.type,
      status: market.status,
      marketKey: params?.marketKey ?? null,
      line: params?.line ?? null,
      betCount: new Set(legs.map((b) => b.betId)).size,
      bettorCount: new Set(legs.map((b) => b.bet.userId)).size,
      sourceBookmakerKeys: Array.isArray(market.sourceBookmakerKeys) ? (market.sourceBookmakerKeys as string[]) : [],
      selections: market.selections.map((s) => ({
        id: s.id,
        name: s.name,
        odds: Number(s.odds),
        betLegs: s.betSelections.length,
      })),
    },
    candidates: candidates.sort(byBookmakerThenLine),
    refreshed,
    source: info
      ? {
          bookmakerCount: info.bookmakerCount,
          marketCount: info.marketCount,
          updatedAt: info.updatedAt ? info.updatedAt.toISOString() : null,
        }
      : null,
    noSource: all.length === 0,
  };
}

// ---------------------------------------------------------------------------
// 2. Preview
// ---------------------------------------------------------------------------

export type SelectionPlan =
  | { oldSelectionId: string; mode: 'match'; outcomeName: string; oddsMode: 'new' | 'keep'; oddsOverride?: number }
  | { oldSelectionId: string; mode: 'keep' }
  | { oldSelectionId: string; mode: 'void' }
  | { oldSelectionId: string; mode: 'block' };

export type ReplaceInput = { candidateKey: string; plans: SelectionPlan[] };

type MigrationRow =
  | { from: string; action: 'void'; legs: number }
  | { from: string; to: string; odds: { from: number; to: number }; legs: number };

export type ReplacePreview = {
  candidate: ReplaceCandidateRow;
  outcomes: ReplaceOutcome[];
  anchors: string[];
  rows: {
    oldSelectionId: string;
    oldName: string;
    oldOdds: number;
    betLegs: number;
    bettors: number;
    suggestion: { outcomeName: string; score: number; reason: string } | null;
    candidates: { outcomeName: string; score: number; reason: string }[];
  }[];
  totals: { bets: number; bettors: number; pendingBets: number; settledBets: number; voidable: boolean; voidBlockedBy: number };
};

function buildPreview(
  market: Awaited<ReturnType<typeof loadMarketOrThrow>>,
  game: { homeTeam: string; awayTeam: string },
  candidate: ReplaceCandidateRow
): ReplacePreview {
  const anchors = [game.homeTeam, game.awayTeam];
  const auto = autoMatch(market.selections.map((s) => ({ id: s.id, name: s.name })), candidate.outcomes, anchors);

  const betIds = new Set<string>();
  const bettors = new Set<string>();
  let pendingBets = 0;
  let settledBets = 0;
  let voidBlockedBy = 0;
  for (const s of market.selections) {
    if (s.betSelections.some((bs) => bs.bet.status !== 'PENDING')) voidBlockedBy++;
    for (const bs of s.betSelections) {
      if (betIds.has(bs.betId)) continue;
      betIds.add(bs.betId);
      bettors.add(bs.bet.userId);
      if (bs.bet.status === 'PENDING') pendingBets++;
      else settledBets++;
    }
  }

  return {
    candidate,
    outcomes: candidate.outcomes,
    anchors,
    rows: market.selections.map((s) => ({
      oldSelectionId: s.id,
      oldName: s.name,
      oldOdds: Number(s.odds),
      betLegs: s.betSelections.length,
      bettors: new Set(s.betSelections.map((bs) => bs.bet.userId)).size,
      suggestion: auto.get(s.id) ?? null,
      candidates: candidate.outcomes
        .map((o) => ({ outcomeName: o.name, ...scoreNames(s.name, o.name, anchors) }))
        .sort((x, y) => y.score - x.score),
    })),
    totals: {
      bets: betIds.size,
      bettors: bettors.size,
      pendingBets,
      settledBets,
      voidable: voidBlockedBy === 0,
      voidBlockedBy,
    },
  };
}

export async function previewReplace(marketId: string, key: string): Promise<ReplacePreview> {
  const { market, game } = await loadGameForMarket(marketId);
  const candidate = await resolveCandidate(game.externalEventId!, game, market, key);
  const siblings = await prisma.market.findMany({
    where: { gameId: game.id },
    select: { id: true, name: true, status: true, parameters: true },
  });
  return buildPreview(market, game, decorateCandidate(candidate, market, siblings));
}

/** Attach the sibling-key flag and the merge target for one candidate. */
function decorateCandidate(
  candidate: ReplaceCandidate,
  market: { id: string; parameters: unknown },
  siblings: { id: string; name: string; status: string; parameters: unknown }[]
): ReplaceCandidateRow {
  const ownKey = paramsOf(market)?.marketKey ?? null;
  // A market already covering this key + line takes the bets instead of a
  // duplicate being recorded alongside it.
  const target = siblings
    .filter((m) => m.id !== market.id && m.status !== 'CANCELLED')
    .find((m) => {
      const p = paramsOf(m);
      return p?.marketKey === candidate.marketKey && (p?.line ?? null) === (candidate.point ?? null);
    });
  return {
    ...candidate,
    siblingKey: !!ownKey && candidate.marketKey !== ownKey,
    mergeInto: target ? { id: target.id, name: target.name, status: target.status } : null,
  };
}

// ---------------------------------------------------------------------------
// 3. Execute
// ---------------------------------------------------------------------------

export async function replaceMarket(marketId: string, input: ReplaceInput, adminUserId: string) {
  // A single bet migration is much smaller than auto replace, but it still runs
  // against a remote database while the odds cron holds locks — retry the
  // transient cases rather than failing the admin's click.
  return withDbRetry('replaceMarket', () => replaceMarketOnce(marketId, input, adminUserId));
}

async function replaceMarketOnce(marketId: string, input: ReplaceInput, adminUserId: string) {
  const { candidateKey, plans } = input;
  if (!candidateKey || !Array.isArray(plans) || plans.length === 0) {
    throw new ApiError(400, 'candidateKey and a plan for every selection are required');
  }

  const { market, game } = await loadGameForMarket(marketId);
  const candidate = await resolveCandidate(game.externalEventId!, game, market, candidateKey);

  const planById = new Map<string, SelectionPlan>();
  for (const p of plans) {
    if (planById.has(p.oldSelectionId)) throw new ApiError(400, 'Duplicate plan for the same selection');
    planById.set(p.oldSelectionId, p);
  }
  const missing = market.selections.filter((s) => !planById.has(s.id));
  if (missing.length) {
    throw new ApiError(400, `Choose what to do with: ${missing.map((s) => `"${s.name}"`).join(', ')}`);
  }
  if (plans.length !== market.selections.length) {
    throw new ApiError(400, 'Plan references a selection that is not in this market');
  }

  // `block` is the admin's hard stop — nothing is written.
  const blocked = plans.find((p) => p.mode === 'block');
  if (blocked) {
    const sel = market.selections.find((s) => s.id === blocked.oldSelectionId);
    const legs = sel?.betSelections.length ?? 0;
    throw new ApiError(
      400,
      `Replacement blocked on "${sel?.name ?? 'a selection'}" — ${legs} bet leg${legs === 1 ? '' : 's'} cannot be mapped onto the new market. Nothing was changed.`
    );
  }

  // Voiding a leg whose ticket already settled would move money that is gone.
  for (const p of plans) {
    if (p.mode !== 'void') continue;
    const sel = market.selections.find((s) => s.id === p.oldSelectionId)!;
    const settled = sel.betSelections.filter((bs) => bs.bet.status !== 'PENDING').length;
    if (settled > 0) {
      throw new ApiError(
        400,
        `"${sel.name}" has ${settled} settled bet leg(s) — those tickets already paid out, so the leg cannot be voided. Match it to a club or keep it as it is.`
      );
    }
  }

  // A new outcome may only be claimed once.
  const claimed = new Set<string>();
  for (const p of plans) {
    if (p.mode !== 'match') continue;
    if (!candidate.outcomes.some((o) => o.name === p.outcomeName)) {
      throw new ApiError(400, `"${p.outcomeName}" is not part of the chosen replacement market`);
    }
    if (claimed.has(p.outcomeName)) {
      throw new ApiError(400, `"${p.outcomeName}" is mapped from two selections — pick a different outcome for one of them`);
    }
    claimed.add(p.outcomeName);
  }

  const type = resolveMarketType(candidate.marketKey);
  const marketName = humanLabel(candidate.marketKey, candidate.point);
  const parameters = { marketKey: candidate.marketKey, line: candidate.point, replacesMarketId: market.id };
  const sourceKeys = [candidate.bookmakerKey];
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    // 1. A market already on the game that covers this key + line takes the bets
    //    instead of a duplicate being recorded. That is how a lay market's bets
    //    reach the game's existing Match Winner. The market being replaced never
    //    counts — replacing with the same line from another bookmaker is the
    //    common case and must create a fresh market.
    const siblings = await tx.market.findMany({
      where: { gameId: game.id },
      include: { selections: true },
    });
    const mergeTarget = siblings.find((m) => {
      if (m.id === market.id || m.status === 'CANCELLED') return false;
      const p = paramsOf(m);
      if (p?.marketKey !== candidate.marketKey) return false;
      return (p?.line ?? null) === (candidate.point ?? null);
    });

    // 2. Build the new selection set from the plan.
    const desired: { oldSelectionId: string; name: string; odds: number }[] = [];
    const desiredNames = new Set<string>();
    for (const sel of market.selections) {
      const plan = planById.get(sel.id)!;
      // `block` was already rejected above; skip keeps the union narrow here.
      if (plan.mode === 'block') continue;
      if (plan.mode === 'void') continue;
      if (plan.mode === 'keep') {
        if (desiredNames.has(sel.name)) {
          throw new ApiError(400, `"${sel.name}" would end up in the new market twice — match it to a club or void it instead of keeping it`);
        }
        desiredNames.add(sel.name);
        desired.push({ oldSelectionId: sel.id, name: sel.name, odds: Number(sel.odds) });
        continue;
      }
      const outcome = candidate.outcomes.find((o) => o.name === plan.outcomeName)!;
      const override = plan.oddsOverride !== undefined ? Number(plan.oddsOverride) : undefined;
      if (override !== undefined && (!Number.isFinite(override) || override <= 1)) {
        throw new ApiError(400, `Manual odds for "${outcome.name}" must be greater than 1`);
      }
      desiredNames.add(outcome.name);
      desired.push({
        oldSelectionId: sel.id,
        name: outcome.name,
        odds: override ?? (plan.oddsMode === 'keep' ? Number(sel.odds) : outcome.odds),
      });
    }

    const created = mergeTarget
      ? mergeTarget
      : await tx.market.create({
          data: {
            gameId: game.id,
            type: type as never,
            name: marketName,
            status: 'OPEN',
            parameters: parameters as never,
            sourceBookmakerKeys: sourceKeys,
            lastSourceCheckedAt: now,
            lastActionById: adminUserId,
            lastActionAt: now,
          },
          include: { selections: true },
        });
    // Merging into a live market: its own source and prices stay as they are,
    // only the arrivals are added.
    if (mergeTarget) {
      await tx.market.update({
        where: { id: mergeTarget.id },
        data: { lastActionById: adminUserId, lastActionAt: now },
      });
    }

    const newSelectionByOld = new Map<string, { id: string; name: string; odds: number }>();
    for (const d of desired) {
      const existing = created.selections.find((s) => s.name === d.name);
      if (existing) {
        // Reuse it untouched — a live market's selections may carry other bets,
        // and its odds are maintained by the scheduled refresh.
        newSelectionByOld.set(d.oldSelectionId, { id: existing.id, name: existing.name, odds: Number(existing.odds) });
        continue;
      }
      const sel = await tx.selection.create({ data: { marketId: created.id, name: d.name, odds: d.odds } });
      await tx.oddsHistory.create({ data: { selectionId: sel.id, odds: d.odds } });
      newSelectionByOld.set(d.oldSelectionId, { id: sel.id, name: d.name, odds: d.odds });
    }

    // 3. Move the bet legs.
    const betIds = new Set<string>();
    let legsRewritten = 0;
    let legsVoided = 0;
    const migration: MigrationRow[] = [];

    for (const sel of market.selections) {
      const plan = planById.get(sel.id)!;
      if (sel.betSelections.length === 0) continue;

      if (plan.mode === 'void') {
        for (const bs of sel.betSelections) {
          if (bs.result === 'VOID') continue;
          await tx.betSelection.update({ where: { id: bs.id }, data: { result: 'VOID' } });
          legsVoided++;
          betIds.add(bs.betId);
        }
        migration.push({ from: sel.name, action: 'void', legs: sel.betSelections.length });
        continue;
      }

      const replacement = newSelectionByOld.get(sel.id)!;
      for (const bs of sel.betSelections) {
        await tx.betSelection.update({
          where: { id: bs.id },
          data: { selectionId: replacement.id, oddsAtPlacement: replacement.odds },
        });
        legsRewritten++;
        betIds.add(bs.betId);
      }
      migration.push({
        from: sel.name,
        to: replacement.name,
        odds: { from: Number(sel.odds), to: replacement.odds },
        legs: sel.betSelections.length,
      });
    }

    // 4. Recompute every touched ticket — open and settled alike.
    const bettors = new Set<string>();
    for (const betId of betIds) {
      const bet = await tx.bet.findUnique({ where: { id: betId }, include: { selections: true } });
      if (!bet) continue;
      bettors.add(bet.userId);

      const live = bet.selections.filter((l) => l.result !== 'VOID');
      const totalOdds = betService.roundOdds(
        live.length ? live.reduce((acc, l) => acc * Number(l.oddsAtPlacement), 1) : 1
      );
      const potentialPayout = betService.roundMoney(Number(bet.stake) * totalOdds);

      const data: Prisma.BetUpdateInput = { totalOdds, potentialPayout };
      // Settled tickets keep their recorded figures consistent with the new odds.
      // No balance moves here — that already happened at settlement time.
      if (bet.status === 'WON') data.settledPayout = potentialPayout;
      else if (bet.status === 'LOST') data.settledPayout = 0;
      await tx.bet.update({ where: { id: betId }, data });
    }

    // 5. Let the shared grader settle anything the voiding completed — it refunds
    //    an all-void ticket and drops a dead leg's odds from the product.
    for (const betId of betIds) {
      const bet = await tx.bet.findUnique({ where: { id: betId }, select: { status: true } });
      if (bet?.status === 'PENDING') await betService.gradeBetIfComplete(tx, betId);
    }

    // 6. Retire the old market. It is kept rather than deleted so the
    //    pre-replacement names/odds and any voided legs stay auditable; the
    //    cancelled status keeps it out of the players' bet slip.
    const oldParams = paramsOf(market) ?? {};
    await tx.market.update({
      where: { id: market.id },
      data: {
        status: 'CANCELLED',
        name: `${market.name} — replaced`,
        parameters: {
          ...oldParams,
          replacedByMarketId: created.id,
          replacedAt: now.toISOString(),
          replacedFromSources: Array.isArray(market.sourceBookmakerKeys) ? market.sourceBookmakerKeys : [],
        } as never,
        lastActionById: adminUserId,
        lastActionAt: now,
      },
    });

    await tx.adminActionLog.create({
      data: {
        userId: adminUserId,
        action: 'MARKET_REPLACED',
        targetType: 'Market',
        targetId: created.id,
        metadata: {
          oldMarketId: market.id,
          oldMarketName: market.name,
          candidateKey: candidate.key,
          bookmakerKey: candidate.bookmakerKey,
          marketKey: candidate.marketKey,
          line: candidate.point,
          oldSelections: market.selections.map((s) => ({ name: s.name, odds: Number(s.odds), legs: s.betSelections.length })),
          newSelections: desired.map((d) => ({ name: d.name, odds: d.odds })),
          migration,
          betsUpdated: betIds.size,
          bettorsAffected: bettors.size,
          legsRewritten,
          legsVoided,
        },
      },
    });

    const refreshed = await tx.market.findUnique({ where: { id: created.id }, include: { selections: true } });
    return {
      market: refreshed,
      replacedMarketId: market.id,
      betsUpdated: betIds.size,
      bettorsAffected: bettors.size,
      legsRewritten,
      legsVoided,
      voidedSelections: plans.filter((p) => p.mode === 'void').length,
    };
  }, { timeout: 60_000, maxWait: 30_000 });
}

// ===========================================================================
// 4. Auto replace — bulk correction for markets nobody has bet on
// ===========================================================================

/**
 * A market with no bet legs can be rebuilt from scratch: selections can be
 * renamed, dropped and added without touching a single ticket. This walks every
 * such market on a game and pulls it back in line with the fetched odds —
 * preferring the bookmaker it already came from, falling back to the first
 * bookmaker in the list when that one no longer offers the market.
 */

type ReconcileUpdate = {
  selectionId: string;
  fromName: string;
  toName: string;
  fromOdds: number;
  toOdds: number;
};
type ReconcileCreate = { name: string; odds: number };
type ReconcileRemove = { selectionId: string; name: string; odds: number };
type ReconcilePlan = { update: ReconcileUpdate[]; create: ReconcileCreate[]; remove: ReconcileRemove[] };

type PlanSource = { id: string; name: string; odds: number };

/** Line up a market's existing selections with a candidate's outcomes. */
function planReconcile(current: PlanSource[], candidate: ReplaceCandidate, anchors: string[]): ReconcilePlan {
  const auto = autoMatch(current.map((s) => ({ id: s.id, name: s.name })), candidate.outcomes, anchors);
  const outcomeByName = new Map(candidate.outcomes.map((o) => [o.name, o]));

  const update: ReconcileUpdate[] = [];
  const remove: ReconcileRemove[] = [];
  const claimed = new Set<string>();
  for (const sel of current) {
    const hit = auto.get(sel.id);
    const outcome = hit ? outcomeByName.get(hit.outcomeName) : undefined;
    if (!outcome) {
      remove.push({ selectionId: sel.id, name: sel.name, odds: sel.odds });
      continue;
    }
    claimed.add(outcome.name);
    update.push({ selectionId: sel.id, fromName: sel.name, toName: outcome.name, fromOdds: sel.odds, toOdds: outcome.odds });
  }
  const create: ReconcileCreate[] = candidate.outcomes
    .filter((o) => !claimed.has(o.name))
    .map((o) => ({ name: o.name, odds: o.odds }));
  return { update, create, remove };
}

const planHasChanges = (p: ReconcilePlan) =>
  p.create.length > 0 ||
  p.remove.length > 0 ||
  p.update.some((u) => u.fromName !== u.toName || Math.abs(u.fromOdds - u.toOdds) > 0.0005);

type AutoMarketRow = {
  id: string;
  name: string;
  type: string;
  status: string;
  parameters: unknown;
  sourceBookmakerKeys: unknown;
  selections: {
    id: string;
    name: string;
    odds: unknown;
    betSelections: { betId: string; bet: { userId: string } }[];
  }[];
};

type AutoFixItem = {
  marketId: string;
  name: string;
  marketKey: string | null;
  fromLine: number | null;
  toLine: number | null;
  lineChanged: boolean;
  fromBookmaker: string | null;
  toBookmaker: string;
  reason: 'same-bookmaker' | 'first-bookmaker';
  hasChanges: boolean;
  plan: ReconcilePlan;
};

type AutoNoReplacement = {
  id: string;
  name: string;
  type: string;
  marketKey: string | null;
  line: number | null;
  sources: string[];
  selectionCount: number;
};

type AutoWithBets = { id: string; name: string; betCount: number; bettorCount: number };

export type AutoReplacePreview = {
  gameId: string;
  fixable: AutoFixItem[];
  noReplacement: AutoNoReplacement[];
  withBets: AutoWithBets[];
  retired: { id: string; name: string; status: string }[];
  source: { bookmakerCount: number; marketCount: number; updatedAt: string | null } | null;
};

async function loadAutoRows(gameId: string): Promise<AutoMarketRow[]> {
  return prisma.market.findMany({
    where: { gameId },
    include: {
      selections: {
        include: { betSelections: { select: { betId: true, bet: { select: { userId: true } } } } },
      },
    },
  }) as unknown as Promise<AutoMarketRow[]>;
}

export async function previewAutoReplace(gameId: string): Promise<AutoReplacePreview> {
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) throw new ApiError(404, 'Game not found');
  if (!game.externalEventId) {
    throw new ApiError(400, 'This game has no odds-api event id — fetch its markets before correcting them');
  }

  const rows = await loadAutoRows(gameId);
  const anchors = [game.homeTeam, game.awayTeam];
  const candidates = collectCandidatesForKeys(game.externalEventId, allMarketKeys());

  // Index the fetched odds by market key so each market finds its own family.
  const byMarketKey = new Map<string, ReplaceCandidate[]>();
  for (const c of candidates) {
    const list = byMarketKey.get(c.marketKey) ?? [];
    list.push(c);
    byMarketKey.set(c.marketKey, list);
  }

  const fixable: AutoFixItem[] = [];
  const noReplacement: AutoNoReplacement[] = [];
  const withBets: AutoWithBets[] = [];
  const retired: { id: string; name: string; status: string }[] = [];

  for (const row of rows) {
    // Already retired by a manual Replace, or settled/cancelled — leave alone.
    if (paramsOf(row)?.replacedByMarketId || row.status === 'SETTLED' || row.status === 'CANCELLED') {
      retired.push({ id: row.id, name: row.name, status: row.status });
      continue;
    }

    const betIds = new Set<string>();
    const bettors = new Set<string>();
    for (const s of row.selections) {
      for (const bs of s.betSelections) {
        betIds.add(bs.betId);
        bettors.add(bs.bet.userId);
      }
    }
    // Players have this market — rebuilding it is the manual Replace's job.
    if (betIds.size > 0) {
      withBets.push({ id: row.id, name: row.name, betCount: betIds.size, bettorCount: bettors.size });
      continue;
    }

    const params = paramsOf(row);
    const currentSources = Array.isArray(row.sourceBookmakerKeys) ? (row.sourceBookmakerKeys as string[]) : [];
    // Recorded from the odds api? match on its exact market key. Hand-made
    // market with no key? fall back to every key that resolves to its type.
    const options = params?.marketKey
      ? byMarketKey.get(params.marketKey) ?? []
      : candidates.filter((c) => resolveMarketType(c.marketKey) === row.type);
    if (options.length === 0) {
      noReplacement.push({
        id: row.id,
        name: row.name,
        type: row.type,
        marketKey: params?.marketKey ?? null,
        line: params?.line ?? null,
        sources: currentSources,
        selectionCount: row.selections.length,
      });
      continue;
    }

    // Same bookmaker first; otherwise the first bookmaker of the list — the
    // same one Auto Fill would pick, since the odds groups are ordered by key.
    const sameBook = options.filter((o) => currentSources.includes(o.bookmakerKey));
    const pool = [...(sameBook.length ? sameBook : options)].sort((a, b) => {
      const byBook = a.bookmakerKey.localeCompare(b.bookmakerKey);
      if (byBook !== 0) return byBook;
      return (a.point ?? 0) - (b.point ?? 0);
    });
    const reason: AutoFixItem['reason'] = sameBook.length ? 'same-bookmaker' : 'first-bookmaker';
    // Keep the current line when the chosen book offers it, else its first line.
    const fromLine = params?.line ?? null;
    const chosen = pool.find((o) => (o.point ?? null) === fromLine) ?? pool[0];

    const plan = planReconcile(
      row.selections.map((s) => ({ id: s.id, name: s.name, odds: Number(s.odds) })),
      chosen,
      anchors
    );

    fixable.push({
      marketId: row.id,
      name: row.name,
      marketKey: params?.marketKey ?? null,
      fromLine,
      toLine: chosen.point,
      lineChanged: (chosen.point ?? null) !== fromLine,
      fromBookmaker: currentSources[0] ?? null,
      toBookmaker: chosen.bookmakerKey,
      reason,
      // Repointing the source counts as a correction even when every price
      // already matches — otherwise the market keeps pointing at a bookmaker
      // that no longer offers it.
      hasChanges: planHasChanges(plan) || currentSources[0] !== chosen.bookmakerKey,
      plan,
    });
  }

  const info = eplGameOdds.getGameOddsFileInfo(game.externalEventId);

  return {
    gameId,
    fixable,
    noReplacement,
    withBets,
    retired,
    source: info
      ? { bookmakerCount: info.bookmakerCount, marketCount: info.marketCount, updatedAt: info.updatedAt ? info.updatedAt.toISOString() : null }
      : null,
  };
}

export type AutoReplaceInput = { noReplacement: 'keep' | 'remove' };

// ---------------------------------------------------------------------------
// Resilience
//
// The database is reached over the network and the odds refresh cron runs against
// the same tables, so a long-lived interactive transaction holding row locks on
// every selection of a game is a reliable way to hit a lock-wait or statement
// timeout — and one failure used to throw away the whole run. Auto replace
// therefore commits one market at a time (short transactions, short locks),
// retries the transient cases, and carries on past a market it could not do.
// A rerun is safe: the preview recomputes what is still outstanding.
// ---------------------------------------------------------------------------

const TRANSIENT_DB_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1011', 'P1017', 'P2024', 'P2034']);
const TRANSIENT_DB_TEXT = [
  'Server has closed',
  'max_statement_time',
  "Can't reach",
  'Timed out',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'Lost connection',
  'connection',
  'Lock wait timeout',
  'Deadlock',
  'try restarting transaction',
];

function isTransientDbError(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown } | null;
  if (err && typeof err.code === 'string' && TRANSIENT_DB_CODES.has(err.code)) return true;
  const msg = String(err?.message ?? e ?? '');
  return TRANSIENT_DB_TEXT.some((t) => msg.includes(t));
}

/** Short per-market transaction: never holds locks long enough to time out. */
const TX_OPTS = { timeout: 60_000, maxWait: 30_000 };

async function withDbRetry<T>(label: string, fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (attempt === tries || !isTransientDbError(e)) throw e;
      const wait = 700 * attempt;
      console.warn(`[marketReplace] ${label} hit a transient database error (attempt ${attempt}/${tries}), retrying in ${wait}ms:`, e instanceof Error ? e.message : String(e));
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

type AutoDetail =
  | { marketId: string; name: string; action: 'skipped' | 'kept'; reason: string }
  | { marketId: string; name: string; action: 'already-correct' }
  | { marketId: string; name: string; action: 'removed' }
  | {
      marketId: string;
      name: string;
      action: 'corrected';
      from: { bookmaker: string | null; line: number | null };
      to: { bookmaker: string; line: number | null };
      reason: AutoFixItem['reason'];
      renamed: { from: string; to: string }[];
      added: ReconcileCreate[];
      removed: { name: string; odds: number }[];
      oddsChanged: number;
    };

type AutoFailure = { marketId: string; name: string; message: string };

type MarketOutcome =
  | { kind: 'skipped'; reason: string }
  | { kind: 'already-correct' }
  | {
      kind: 'corrected';
      renamed: number;
      added: number;
      removed: number;
      oddsChanged: number;
    };

type RemoveOutcome = { kind: 'removed' } | { kind: 'kept'; reason: string };

/** Apply one market's plan. Runs inside its own short transaction. */
async function correctOneMarket(
  tx: Prisma.TransactionClient,
  item: AutoFixItem,
  now: Date,
  adminUserId: string
): Promise<MarketOutcome> {
  // A player may have slipped a bet in since the preview was rendered.
  const legs = await tx.betSelection.count({ where: { selection: { marketId: item.marketId } } });
  if (legs > 0) return { kind: 'skipped', reason: `${legs} bet leg(s) appeared` };
  if (!item.hasChanges) return { kind: 'already-correct' };

  await tx.market.update({
    where: { id: item.marketId },
    data: {
      sourceBookmakerKeys: [item.toBookmaker],
      lastSourceCheckedAt: now,
      lastActionById: adminUserId,
      lastActionAt: now,
      ...(item.lineChanged && item.marketKey
        ? { name: humanLabel(item.marketKey, item.toLine), parameters: { marketKey: item.marketKey, line: item.toLine } as never }
        : {}),
    },
  });

  let renamed = 0;
  let oddsChanged = 0;
  const repriced: { selectionId: string; odds: number }[] = [];
  const fresh: { selectionId: string; odds: number }[] = [];

  for (const u of item.plan.update) {
    const hasNewPrice = Math.abs(u.fromOdds - u.toOdds) > 0.0005;
    if (u.fromName !== u.toName) renamed++;
    if (hasNewPrice) {
      oddsChanged++;
      repriced.push({ selectionId: u.selectionId, odds: u.toOdds });
    }
    await tx.selection.update({ where: { id: u.selectionId }, data: { name: u.toName, odds: u.toOdds } });
  }

  for (const c of item.plan.create) {
    const sel = await tx.selection.create({ data: { marketId: item.marketId, name: c.name, odds: c.odds } });
    fresh.push({ selectionId: sel.id, odds: c.odds });
  }

  // One bulk insert instead of a round trip per recorded price.
  const history = [...repriced, ...fresh];
  if (history.length) await tx.oddsHistory.createMany({ data: history });

  // Dropped selections have no bet legs (checked above), so the FK is clear and
  // their odds history cascades away with them.
  if (item.plan.remove.length) {
    await tx.selection.deleteMany({ where: { id: { in: item.plan.remove.map((r) => r.selectionId) } } });
  }

  return { kind: 'corrected', renamed, added: item.plan.create.length, removed: item.plan.remove.length, oddsChanged };
}

export async function autoReplace(gameId: string, input: AutoReplaceInput, adminUserId: string) {
  const decision = input?.noReplacement;
  if (decision !== 'keep' && decision !== 'remove') {
    throw new ApiError(400, 'Decide what happens to the markets with no replacement: keep or remove');
  }

  const preview = await previewAutoReplace(gameId);
  const now = new Date();

  const details: AutoDetail[] = [];
  const failures: AutoFailure[] = [];
  const removed: { id: string; name: string }[] = [];

  let marketsCorrected = 0;
  let marketsUnchanged = 0;
  let marketsRemoved = 0;
  let selectionsRenamed = 0;
  let selectionsAdded = 0;
  let selectionsRemoved = 0;
  let oddsChanged = 0;

  const fail = (marketId: string, name: string, e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    failures.push({ marketId, name, message });
    details.push({ marketId, name, action: 'skipped', reason: `failed — ${message}` });
  };

  for (const item of preview.fixable) {
    try {
      const outcome = await withDbRetry(`autoReplace "${item.name}"`, () =>
        prisma.$transaction((tx) => correctOneMarket(tx, item, now, adminUserId), TX_OPTS)
      );

      if (outcome.kind === 'skipped') {
        details.push({ marketId: item.marketId, name: item.name, action: 'skipped', reason: outcome.reason });
        continue;
      }
      if (outcome.kind === 'already-correct') {
        marketsUnchanged++;
        details.push({ marketId: item.marketId, name: item.name, action: 'already-correct' });
        continue;
      }

      selectionsRenamed += outcome.renamed;
      selectionsAdded += outcome.added;
      selectionsRemoved += outcome.removed;
      oddsChanged += outcome.oddsChanged;
      marketsCorrected++;
      details.push({
        marketId: item.marketId,
        name: item.name,
        action: 'corrected',
        from: { bookmaker: item.fromBookmaker, line: item.fromLine },
        to: { bookmaker: item.toBookmaker, line: item.toLine },
        reason: item.reason,
        renamed: item.plan.update.filter((u) => u.fromName !== u.toName).map((u) => ({ from: u.fromName, to: u.toName })),
        added: item.plan.create,
        removed: item.plan.remove.map((r) => ({ name: r.name, odds: r.odds })),
        oddsChanged: outcome.oddsChanged,
      });
    } catch (e) {
      // One market must never cost the rest of the run — report it and carry on.
      fail(item.marketId, item.name, e);
    }
  }

  // Markets the odds file no longer offers: the admin chose keep or remove.
  for (const nr of preview.noReplacement) {
    if (decision !== 'remove') {
      details.push({ marketId: nr.id, name: nr.name, action: 'kept', reason: 'admin chose to keep' });
      continue;
    }
    try {
      const outcome = await withDbRetry(`autoRemove "${nr.name}"`, () =>
        prisma.$transaction<RemoveOutcome>(
          async (tx) => {
            const legs = await tx.betSelection.count({ where: { selection: { marketId: nr.id } } });
            if (legs > 0) return { kind: 'kept', reason: `${legs} bet leg(s) appeared` };
            const selectionIds = (await tx.selection.findMany({ where: { marketId: nr.id }, select: { id: true } })).map((s) => s.id);
            await tx.oddsHistory.deleteMany({ where: { selectionId: { in: selectionIds } } });
            await tx.selection.deleteMany({ where: { id: { in: selectionIds } } });
            await tx.market.delete({ where: { id: nr.id } });
            return { kind: 'removed' };
          },
          TX_OPTS
        )
      );
      if (outcome.kind === 'kept') {
        details.push({ marketId: nr.id, name: nr.name, action: 'kept', reason: outcome.reason });
        continue;
      }
      removed.push({ id: nr.id, name: nr.name });
      marketsRemoved++;
      details.push({ marketId: nr.id, name: nr.name, action: 'removed' });
    } catch (e) {
      fail(nr.id, nr.name, e);
    }
  }

  // Audit trail last, and never at the cost of the work itself.
  if (marketsCorrected || marketsRemoved) {
    try {
      await withDbRetry("autoReplace audit log", () =>
        prisma.adminActionLog.create({
          data: {
            userId: adminUserId,
            action: 'MARKETS_AUTO_REPLACED',
            targetType: 'Game',
            targetId: gameId,
            metadata: {
              noReplacementDecision: decision,
              marketsCorrected,
              marketsUnchanged,
              marketsRemoved,
              selectionsRenamed,
              selectionsAdded,
              selectionsRemoved,
              oddsChanged,
              failures,
              marketsWithBetsLeftAlone: preview.withBets.map((b) => ({ id: b.id, name: b.name, bets: b.betCount })),
              details,
            },
          },
        })
      );
    } catch (e) {
      console.error('[marketReplace] auto replace finished but the audit log could not be written:', e instanceof Error ? e.message : e);
    }
  }

  return {
    marketsCorrected,
    marketsUnchanged,
    marketsRemoved,
    marketsKept: decision === 'keep' ? preview.noReplacement.length : 0,
    selectionsRenamed,
    selectionsAdded,
    selectionsRemoved,
    oddsChanged,
    leftAloneWithBets: preview.withBets.length,
    failures,
    details,
  };
}

// ===========================================================================
// 5. Sync player tickets — push corrected names (and optionally prices) out to
//    the bets that were already placed
// ===========================================================================

/**
 * Every ticket leg points at a Selection, and the ticket displays that
 * Selection's name. So correcting the club name on the selection itself rewrites
 * the name on every ticket holding it, in one statement.
 *
 * The price is different: `BetSelection.oddsAtPlacement` is a snapshot taken at
 * placement time, so bringing a ticket's price in line with the corrected market
 * means rewriting every snapshot plus the ticket's totalOdds / potentialPayout.
 * That second half is opt-in (`updateOdds`) because it changes what a ticket is
 * worth — renaming a club never does.
 */

type TicketSyncRow = {
  selectionId: string;
  fromName: string;
  toName: string;
  fromOdds: number;
  toOdds: number;
  reason: string;
  betCount: number;
};

type TicketSyncMarket = {
  marketId: string;
  name: string;
  type: string;
  status: string;
  marketKey: string | null;
  line: number | null;
  fromBookmaker: string | null;
  sourceBookmaker: string;
  rows: TicketSyncRow[];
  bets: number;
  bettors: number;
};

export type TicketSyncPreview = {
  gameId: string;
  markets: TicketSyncMarket[];
  noSource: { marketId: string; name: string; marketKey: string | null; line: number | null; bets: number }[];
  totals: { bets: number; bettors: number; renames: number; priceChanges: number };
};

/** Pick the market's authoritative version: its own book first, else the list's first. */
function pickAuthoritative(
  candidates: ReplaceCandidate[],
  sources: string[],
  line: number | null
): ReplaceCandidate | null {
  if (candidates.length === 0) return null;
  const sameBook = candidates.filter((c) => sources.includes(c.bookmakerKey));
  const pool = [...(sameBook.length ? sameBook : candidates)].sort((a, b) => {
    const byBook = a.bookmakerKey.localeCompare(b.bookmakerKey);
    if (byBook !== 0) return byBook;
    return (a.point ?? 0) - (b.point ?? 0);
  });
  return pool.find((c) => (c.point ?? null) === line) ?? pool[0];
}

export async function previewTicketSync(gameId: string): Promise<TicketSyncPreview> {
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) throw new ApiError(404, 'Game not found');
  if (!game.externalEventId) {
    throw new ApiError(400, 'This game has no odds-api event id — fetch its markets before syncing tickets');
  }

  const anchors = [game.homeTeam, game.awayTeam];
  const all = collectCandidatesForKeys(game.externalEventId, allMarketKeys());
  const byMarketKey = new Map<string, ReplaceCandidate[]>();
  for (const c of all) {
    const list = byMarketKey.get(c.marketKey) ?? [];
    list.push(c);
    byMarketKey.set(c.marketKey, list);
  }

  const rows = await prisma.market.findMany({
    where: { gameId },
    include: {
      selections: {
        include: { betSelections: { select: { betId: true, bet: { select: { userId: true } } } } },
      },
    },
  });

  const markets: TicketSyncMarket[] = [];
  const noSource: TicketSyncPreview['noSource'] = [];
  let totalBets = 0;
  let totalBettors = 0;
  let totalRenames = 0;
  let totalPriceChanges = 0;
  const seenBettors = new Set<string>();

  for (const market of rows) {
    if (paramsOf(market)?.replacedByMarketId || market.status === 'SETTLED' || market.status === 'CANCELLED') continue;

    const betIds = new Set<string>();
    const marketBettors = new Set<string>();
    for (const s of market.selections) {
      for (const bs of s.betSelections) {
        betIds.add(bs.betId);
        marketBettors.add(bs.bet.userId);
      }
    }
    if (betIds.size === 0) continue;

    const params = paramsOf(market);
    const line = params?.line ?? null;
    const sources = Array.isArray(market.sourceBookmakerKeys) ? (market.sourceBookmakerKeys as string[]) : [];
    const candidates = params?.marketKey
      ? byMarketKey.get(params.marketKey) ?? []
      : all.filter((c) => resolveMarketType(c.marketKey) === market.type);

    const chosen = pickAuthoritative(candidates, sources, line);
    if (!chosen) {
      noSource.push({
        marketId: market.id,
        name: market.name,
        marketKey: params?.marketKey ?? null,
        line,
        bets: betIds.size,
      });
      continue;
    }

    const auto = autoMatch(market.selections.map((s) => ({ id: s.id, name: s.name })), chosen.outcomes, anchors);
    const outcomeByName = new Map(chosen.outcomes.map((o) => [o.name, o]));

    const syncRows: TicketSyncRow[] = [];
    for (const sel of market.selections) {
      const hit = auto.get(sel.id);
      const outcome = hit ? outcomeByName.get(hit.outcomeName) : undefined;
      if (!outcome) continue;
      const fromOdds = Number(sel.odds);
      const renamed = sel.name !== outcome.name;
      const repriced = Math.abs(fromOdds - outcome.odds) > 0.0005;
      if (!renamed && !repriced) continue;
      syncRows.push({
        selectionId: sel.id,
        fromName: sel.name,
        toName: outcome.name,
        fromOdds,
        toOdds: outcome.odds,
        reason: hit?.reason ?? 'matched',
        betCount: sel.betSelections.length,
      });
    }
    if (syncRows.length === 0) continue;

    for (const b of marketBettors) seenBettors.add(b);
    totalBets += betIds.size;
    totalRenames += syncRows.filter((r) => r.fromName !== r.toName).length;
    totalPriceChanges += syncRows.filter((r) => Math.abs(r.fromOdds - r.toOdds) > 0.0005).length;

    markets.push({
      marketId: market.id,
      name: market.name,
      type: market.type,
      status: market.status,
      marketKey: params?.marketKey ?? null,
      line,
      fromBookmaker: sources[0] ?? null,
      sourceBookmaker: chosen.bookmakerKey,
      rows: syncRows,
      bets: betIds.size,
      bettors: marketBettors.size,
    });
  }

  totalBettors = seenBettors.size;

  return {
    gameId,
    markets,
    noSource,
    totals: { bets: totalBets, bettors: totalBettors, renames: totalRenames, priceChanges: totalPriceChanges },
  };
}

export type TicketSyncInput = { updateOdds?: boolean };

export async function syncTickets(gameId: string, input: TicketSyncInput, adminUserId: string) {
  return withDbRetry('syncTickets', () => syncTicketsOnce(gameId, input, adminUserId));
}

async function syncTicketsOnce(gameId: string, input: TicketSyncInput, adminUserId: string) {
  const updateOdds = input?.updateOdds === true;
  const preview = await previewTicketSync(gameId);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    // affectedBets: tickets whose displayed club name changes (or whose price
    // changes when updateOdds is on). needsRecalc: tickets whose odds product
    // moved, so their totals must be rebuilt.
    const affectedBets = new Set<string>();
    const needsRecalc = new Set<string>();
    const bettors = new Set<string>();
    const touchedSelections: { market: string; from: string; to: string; oddsFrom: number; oddsTo: number }[] = [];
    let renamed = 0;
    let repriced = 0;
    let legsRewritten = 0;

    for (const market of preview.markets) {
      for (const row of market.rows) {
        const isRename = row.fromName !== row.toName;
        const isReprice = updateOdds && Math.abs(row.fromOdds - row.toOdds) > 0.0005;
        if (!isRename && !isReprice) continue;

        // One lookup per selection covers both the rename blast radius and the
        // price rewrite.
        const legs = await tx.betSelection.findMany({
          where: { selectionId: row.selectionId },
          select: { id: true, betId: true },
        });
        for (const leg of legs) affectedBets.add(leg.betId);

        const data: { name?: string; odds?: number } = {};
        if (isRename) {
          data.name = row.toName;
          renamed++;
        }
        if (isReprice) {
          data.odds = row.toOdds;
          repriced++;
          for (const leg of legs) {
            await tx.betSelection.update({ where: { id: leg.id }, data: { oddsAtPlacement: row.toOdds } });
            legsRewritten++;
            needsRecalc.add(leg.betId);
          }
        }

        await tx.selection.update({ where: { id: row.selectionId }, data });
        if (data.odds !== undefined) {
          await tx.oddsHistory.create({ data: { selectionId: row.selectionId, odds: row.toOdds } });
        }
        touchedSelections.push({
          market: market.name,
          from: row.fromName,
          to: row.toName,
          oddsFrom: row.fromOdds,
          oddsTo: data.odds ?? row.fromOdds,
        });
      }
    }

    // Rebuild the totals on every ticket whose odds product moved.
    for (const betId of needsRecalc) {
      const bet = await tx.bet.findUnique({ where: { id: betId }, include: { selections: true } });
      if (!bet) continue;
      const live = bet.selections.filter((l) => l.result !== 'VOID');
      const totalOdds = betService.roundOdds(live.length ? live.reduce((acc, l) => acc * Number(l.oddsAtPlacement), 1) : 1);
      const potentialPayout = betService.roundMoney(Number(bet.stake) * totalOdds);
      const data: Prisma.BetUpdateInput = { totalOdds, potentialPayout };
      if (bet.status === 'WON') data.settledPayout = potentialPayout;
      else if (bet.status === 'LOST') data.settledPayout = 0;
      await tx.bet.update({ where: { id: betId }, data });
    }

    for (const betId of affectedBets) {
      const bet = await tx.bet.findUnique({ where: { id: betId }, select: { userId: true } });
      if (bet) bettors.add(bet.userId);
    }

    if (touchedSelections.length) {
      await tx.adminActionLog.create({
        data: {
          userId: adminUserId,
          action: 'BET_TICKETS_SYNCED',
          targetType: 'Game',
          targetId: gameId,
          metadata: {
            updateOdds,
            renamed,
            repriced,
            legsRewritten,
            betsUpdated: affectedBets.size,
            bettorsAffected: bettors.size,
            changes: touchedSelections,
            marketsLeftAlone: preview.noSource.map((m) => ({ id: m.marketId, name: m.name, bets: m.bets })),
          },
        },
      });
    }

    // Note: Game.lastOddsFetchAt is deliberately NOT bumped — this is a data
    // correction, not a fetch, and moving it would delay the cron odds refresh.
    // Market.lastSourceCheckedAt is the accurate place to record the new source.
    if (repriced) {
      await tx.market.updateMany({
        where: { id: { in: preview.markets.map((m) => m.marketId) } },
        data: { lastSourceCheckedAt: now },
      });
    }

    return {
      marketsUpdated: preview.markets.length,
      renamed,
      repriced,
      legsRewritten,
      betsUpdated: affectedBets.size,
      bettorsAffected: bettors.size,
      updateOdds,
      leftAloneNoSource: preview.noSource.length,
    };
  }, { timeout: 60_000, maxWait: 30_000 });
}