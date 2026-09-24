import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import fs from 'fs';
import path from 'path';
import * as marketService from './market.service';
import * as betService from './bet.service';
import { notify } from './notification.service';
import { getFootballDataMatchDetailUrl, footballDataFetchOptions } from '../../codes';

const round2 = (n: unknown) => Math.round(Number(n) * 100) / 100;
const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

export type GameResult = {
  finished: boolean;
  matchStatus: string;
  homeFT: number | null;
  awayFT: number | null;
  homeHT: number | null;
  awayHT: number | null;
  winner: 'HOME' | 'AWAY' | 'DRAW' | null;
  source: 'gamescore' | 'football-data' | 'none';
};

export type FdMatchDetail = {
  id: number;
  status: string;
  utcDate: string;
  score?: { winner?: string | null; fullTime?: { home: number | null; away: number | null } | null; halfTime?: { home: number | null; away: number | null } | null };
};

const FD_FINISHED = new Set(['FINISHED', 'AWARDED', 'WALKOVER', 'REGULAR_TIME']);
const FD_INPLAY = new Set(['IN_PLAY', 'LIVE', 'FIRST_HALF', 'SECOND_HALF', 'HALF_TIME', 'BREAK_TIME', 'EXTRA_TIME', 'PENALTY', 'PAUSED']);
const FD_POSTPONED = new Set(['POSTPONED']);
const FD_CANCELLED = new Set(['CANCELLED', 'ABANDONED']);
const FD_SUSPENDED = new Set(['SUSPENDED']);

export function fdStatusBucket(status: string): 'FINISHED' | 'LIVE' | 'SCHEDULED' | 'POSTPONED' | 'CANCELLED' | 'SUSPENDED' {
  const u = (status ?? '').toUpperCase();
  if (FD_FINISHED.has(u)) return 'FINISHED';
  if (FD_INPLAY.has(u)) return 'LIVE';
  if (FD_POSTPONED.has(u)) return 'POSTPONED';
  if (FD_CANCELLED.has(u)) return 'CANCELLED';
  if (FD_SUSPENDED.has(u)) return 'SUSPENDED';
  return 'SCHEDULED';
}

export async function fetchFootballDataMatch(matchId: number): Promise<FdMatchDetail> {
  const res = await fetch(getFootballDataMatchDetailUrl(matchId), footballDataFetchOptions());
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new ApiError(res.status, `football-data fetch failed: ${res.status} ${t.slice(0, 200)}`);
  }
  return (await res.json()) as FdMatchDetail;
}

function winnerFromFT(home: number | null, away: number | null, fdWinner?: string | null): 'HOME' | 'AWAY' | 'DRAW' | null {
  if (fdWinner === 'HOME_TEAM') return 'HOME';
  if (fdWinner === 'AWAY_TEAM') return 'AWAY';
  if (fdWinner === 'DRAW') return 'DRAW';
  if (home == null || away == null) return null;
  if (home > away) return 'HOME';
  if (home < away) return 'AWAY';
  return 'DRAW';
}

async function findFootballDataMatchId(gameId: string): Promise<number | null> {
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    select: { specifications: true, score: { select: { footballDataMatchId: true } }, stagedGame: { select: { footballDataMatchId: true } } },
  });
  if (!game) return null;
  const spec = (game.specifications ?? {}) as { footballDataMatchId?: unknown };
  if (typeof spec.footballDataMatchId === 'number') return spec.footballDataMatchId;
  if (game.score?.footballDataMatchId != null) return game.score.footballDataMatchId;
  if (game.stagedGame?.footballDataMatchId != null) return game.stagedGame.footballDataMatchId;
  return null;
}

/**
 * Resolve the final result for a game: prefer a stored GameScore, otherwise fetch + persist
 * a GameScore from football-data (only when the match has actually finished).
 */
export async function resolveGameResult(gameId: string): Promise<GameResult> {
  const score = await prisma.gameScore.findUnique({ where: { gameId } });
  const storedFinished = !!score && (fdStatusBucket(score.status) === 'FINISHED' || (score.winner != null && score.homeScoreFT != null && score.awayScoreFT != null));
  if (score && storedFinished) {
    return {
      finished: true,
      matchStatus: score.status,
      homeFT: score.homeScoreFT,
      awayFT: score.awayScoreFT,
      homeHT: score.homeScoreHT,
      awayHT: score.awayScoreHT,
      winner: winnerFromFT(score.homeScoreFT, score.awayScoreFT, score.winner),
      source: 'gamescore',
    };
  }

  const matchId = await findFootballDataMatchId(gameId);
  if (matchId == null) {
    if (score) return { finished: false, matchStatus: score.status, homeFT: score.homeScoreFT, awayFT: score.awayScoreFT, homeHT: score.homeScoreHT, awayHT: score.awayScoreHT, winner: winnerFromFT(score.homeScoreFT, score.awayScoreFT, score.winner), source: 'gamescore' };
    return { finished: false, matchStatus: 'SCHEDULED', homeFT: null, awayFT: null, homeHT: null, awayHT: null, winner: null, source: 'none' };
  }

  let fd: FdMatchDetail;
  try {
    fd = await fetchFootballDataMatch(matchId);
  } catch {
    if (score) return { finished: false, matchStatus: score.status, homeFT: score.homeScoreFT, awayFT: score.awayScoreFT, homeHT: score.homeScoreHT, awayHT: score.awayScoreHT, winner: winnerFromFT(score.homeScoreFT, score.awayScoreFT, score.winner), source: 'gamescore' };
    return { finished: false, matchStatus: 'UNKNOWN', homeFT: null, awayFT: null, homeHT: null, awayHT: null, winner: null, source: 'none' };
  }
  const bucket = fdStatusBucket(fd.status);
  const homeFT = fd.score?.fullTime?.home ?? null;
  const awayFT = fd.score?.fullTime?.away ?? null;
  const htHome = fd.score?.halfTime?.home ?? null;
  const htAway = fd.score?.halfTime?.away ?? null;
  const finished = bucket === 'FINISHED' && homeFT != null && awayFT != null;
  const hasScore = homeFT != null && awayFT != null;
  const winner = finished ? winnerFromFT(homeFT, awayFT, fd.score?.winner) : null;
  const winnerStore = finished ? (fd.score?.winner ?? (winner === 'HOME' ? 'HOME_TEAM' : winner === 'AWAY' ? 'AWAY_TEAM' : winner === 'DRAW' ? 'DRAW' : null)) : null;

  // Persist a GameScore whenever football-data exposes a score line (in-play OR final) so the
  // live/ended result surfaces in lists and tables without a re-fetch on every read.
  if (hasScore) {
    try {
      await prisma.gameScore.upsert({
        where: { gameId },
        update: { footballDataMatchId: fd.id, homeScoreFT: homeFT, awayScoreFT: awayFT, homeScoreHT: htHome ?? 0, awayScoreHT: htAway ?? 0, winner: winnerStore, status: fd.status, fetchedAt: new Date() },
        create: { gameId, footballDataMatchId: fd.id, homeScoreFT: homeFT!, awayScoreFT: awayFT!, homeScoreHT: htHome ?? 0, awayScoreHT: htAway ?? 0, winner: winnerStore, status: fd.status },
      });
    } catch (e) {
      // footballDataMatchId is @unique — if another Game already owns this match id
      // (e.g. duplicate seeded Game + staged-confirmed Game), do not crash the
      // settlement view. Reuse the existing score row or fall back to memory.
      const code = (e as { code?: string })?.code;
      const msg = e instanceof Error ? e.message : String(e);
      if (code === 'P2002' || /Unique constraint|Duplicate entry/i.test(msg)) {
        const existing = await prisma.gameScore.findUnique({ where: { footballDataMatchId: fd.id } });
        if (existing && existing.gameId !== gameId) {
          // Update the existing winner/status from live fd if needed, but do not duplicate.
          try { await prisma.gameScore.update({ where: { id: existing.id }, data: { homeScoreFT: homeFT, awayScoreFT: awayFT, homeScoreHT: htHome ?? 0, awayScoreHT: htAway ?? 0, winner: winnerStore, status: fd.status, fetchedAt: new Date() } }); } catch {}
        }
      } else {
        throw e;
      }
    }
  }

  return {
    finished,
    matchStatus: fd.status,
    homeFT,
    awayFT,
    homeHT: htHome,
    awayHT: htAway,
    winner,
    source: 'football-data',
  };
}

const TEAM_TOKEN_EXPANSIONS: Record<string, string> = {
  man: 'manchester',
  utd: 'united',
  nottm: 'nottingham',
  wolves: 'wolverhampton',
  st: 'saint',
  saints: 'saint',
};
const TEAM_NOISE_TOKENS = new Set(['fc', 'afc', 'cfc', 'cf', 'sc', 'fk', 'club']);

function teamTokens(s: unknown): Set<string> {
  return new Set(
    norm(s)
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(' ')
      .filter(Boolean)
      .map((t) => TEAM_TOKEN_EXPANSIONS[t] ?? t)
      .filter((t) => !TEAM_NOISE_TOKENS.has(t))
  );
}

/** True when a selection name and a game team string refer to the same club. */
export function teamNameMatches(a: string, b: string): boolean {
  const A = teamTokens(a);
  const B = teamTokens(b);
  if (A.size === 0 || B.size === 0) return false;
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  if (Array.from(small).every((t) => large.has(t))) {
    if (A.size === B.size) return true;
    if (small.size >= 2) return true;
  }
  return false;
}

/**
 * Settlement registry (src/config/marketSettlement.json): how each odds-api
 * marketKey is graded from a result. Keyed by marketKey (not DB type) so a
 * market is graded the same no matter how it was typed at approval time.
 * isWinning = null means push/void.
 */
type SettleKind = 'match_winner' | 'double_chance' | 'totals' | 'team_totals' | 'handicap' | 'btts' | 'correct_score' | 'htft' | 'none';
type ScorePeriod = 'FT' | 'HT' | 'H2' | 'HT_FT';
type SettleRule = { settle: SettleKind; period?: ScorePeriod; drawPush?: boolean; reason?: string };

const BUILTIN_RULES: Record<string, SettleRule> = {
  h2h: { settle: 'match_winner', period: 'FT' },
  totals: { settle: 'totals', period: 'FT' },
  spreads: { settle: 'handicap', period: 'FT' },
  btts: { settle: 'btts', period: 'FT' },
};

let cachedRules: Record<string, SettleRule> | null = null;
function settlementRules(): Record<string, SettleRule> {
  if (cachedRules) return cachedRules;
  const candidates = [
    path.join(__dirname, '..', 'config', 'marketSettlement.json'),
    path.join(process.cwd(), 'src', 'config', 'marketSettlement.json'),
  ];
  for (const f of candidates) {
    try {
      if (fs.existsSync(f)) {
        const raw = JSON.parse(fs.readFileSync(f, 'utf-8')) as Record<string, unknown>;
        const rules: Record<string, SettleRule> = { ...BUILTIN_RULES };
        for (const [k, v] of Object.entries(raw)) {
          if (k.startsWith('_')) continue;
          const r = v as SettleRule;
          if (r && typeof r.settle === 'string') rules[k] = r;
        }
        cachedRules = rules;
        return rules;
      }
    } catch {
      // fall through to built-ins
    }
  }
  cachedRules = { ...BUILTIN_RULES };
  return cachedRules;
}

function ruleForMarket(market: { type: string; parameters: unknown }): SettleRule | null {
  const params = (market.parameters ?? {}) as { marketKey?: unknown };
  const key = typeof params.marketKey === 'string' ? params.marketKey : null;
  if (key) {
    const r = settlementRules()[key];
    if (r) return r;
  }
  // Fallback for unknown keys: grade by DB type on full-time (legacy behaviour)
  switch (market.type) {
    case 'MATCH_WINNER': return { settle: 'match_winner', period: 'FT' };
    case 'OVER_UNDER': return { settle: 'totals', period: 'FT' };
    case 'HANDICAP': return { settle: 'handicap', period: 'FT' };
    case 'BOTH_TEAMS_TO_SCORE': return { settle: 'btts', period: 'FT' };
    default: return null;
  }
}

/** Why a market can never auto-settle (shown in the UI); null = may be resolvable. */
export function manualReason(market: { type: string; parameters: unknown }): string | null {
  const r = ruleForMarket(market);
  if (!r) return null;
  if (r.settle === 'none') return r.reason ?? 'not supported';
  return null;
}

/** True when every token of the team name appears in the outcome name. */
function outcomeMentionsTeam(outcome: string, team: string): boolean {
  const t = [...teamTokens(team)];
  const o = new Set(teamTokens(outcome));
  return t.length > 0 && t.every((tok) => o.has(tok));
}

type PeriodGoals = { home: number; away: number; htHome: number | null; htAway: number | null };

function periodGoals(period: ScorePeriod | undefined, result: GameResult): PeriodGoals | null {
  const p = period ?? 'FT';
  const { homeFT, awayFT, homeHT, awayHT } = result;
  if (p === 'FT') {
    if (homeFT == null || awayFT == null) return null;
    return { home: homeFT, away: awayFT, htHome: homeHT, htAway: awayHT };
  }
  if (p === 'HT') {
    if (homeHT == null || awayHT == null) return null;
    return { home: homeHT, away: awayHT, htHome: homeHT, htAway: awayHT };
  }
  if (p === 'H2') {
    // second-half goals = full-time minus half-time
    if (homeFT == null || awayFT == null || homeHT == null || awayHT == null) return null;
    return { home: homeFT - homeHT, away: awayFT - awayHT, htHome: homeHT, htAway: awayHT };
  }
  // HT_FT: both needed
  if (homeFT == null || awayFT == null || homeHT == null || awayHT == null) return null;
  return { home: homeFT, away: awayFT, htHome: homeHT, htAway: awayHT };
}

function sideWinner(home: number, away: number): 'HOME' | 'AWAY' | 'DRAW' {
  if (home > away) return 'HOME';
  if (home < away) return 'AWAY';
  return 'DRAW';
}

function parseChanceSide(part: string, game: { homeTeam: string; awayTeam: string }): 'HOME' | 'AWAY' | 'DRAW' | null {
  const n = norm(part);
  if (!n) return null;
  if (/^[12x]+$/.test(n)) {
    // compact form like "1X" — caller splits into single chars before calling
    return null;
  }
  if (n === 'draw' || n === 'x' || n.includes('draw')) return 'DRAW';
  if (n === '1' || n === 'home' || n.includes('home')) return 'HOME';
  if (n === '2' || n === 'away' || n.includes('away')) return 'AWAY';
  if (outcomeMentionsTeam(part, game.homeTeam)) return 'HOME';
  if (outcomeMentionsTeam(part, game.awayTeam)) return 'AWAY';
  return null;
}

function parseDoubleChance(name: string, game: { homeTeam: string; awayTeam: string }): Set<'HOME' | 'AWAY' | 'DRAW'> | null {
  const rawParts = name.split(/\s+or\s+|\s*\/\s*/i).map((s) => s.trim()).filter(Boolean);
  const parts: string[] = [];
  for (const p of rawParts) {
    if (/^[12xX]+$/.test(p.replace(/\s/g, '')) && p.replace(/\s/g, '').length > 1) {
      parts.push(...p.replace(/\s/g, '').split(''));
    } else {
      parts.push(p);
    }
  }
  const covered = new Set<'HOME' | 'AWAY' | 'DRAW'>();
  for (const p of parts) {
    const side = parseChanceSide(p, game);
    if (!side) return null;
    covered.add(side);
  }
  return covered.size > 0 ? covered : null;
}

function parseScoreline(name: string): [number, number] | 'OTHER' | null {
  const lower = norm(name);
  if (/other|unlisted|any other/.test(lower)) return 'OTHER';
  const bar = name.split('|');
  if (bar.length === 2) {
    const a = bar[0].match(/(\d+)\s*$/);
    const b = bar[1].match(/(\d+)\s*$/);
    if (a && b) return [parseInt(a[1], 10), parseInt(b[1], 10)];
  }
  const m = name.match(/(\d+)\s*[-:–]\s*(\d+)/);
  if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  return null;
}

/**
 * Determine winning selections for a market given a finished result.
 * Driven by src/config/marketSettlement.json (score period + outcome rules).
 * Returns a Map<selectionId, isWinning> when resolvable, or null if this market
 * cannot be auto-settled (needs manual settlement).
 */
function resolveMarketWinners(market: { type: string; name: string; parameters: unknown; selections: { id: string; name: string }[] }, game: { homeTeam: string; awayTeam: string }, result: GameResult): Map<string, boolean | null> | null {
  if (!result.finished) return null;
  const rule = ruleForMarket(market);
  if (!rule || rule.settle === 'none') return null;
  const g = periodGoals(rule.period, result);
  if (!g) return null;
  const winner = sideWinner(g.home, g.away);

  const params = (market.parameters ?? {}) as { line?: unknown };
  const line = typeof params.line === 'number' ? params.line : null;
  const by = (pred: (name: string) => boolean) => market.selections.filter((s) => pred(norm(s.name)));

  switch (rule.settle) {
    case 'match_winner': {
      if (rule.drawPush && winner === 'DRAW') {
        return new Map(market.selections.map((s) => [s.id, null]));
      }
      const wantRaw = winner === 'HOME' ? game.homeTeam : winner === 'AWAY' ? game.awayTeam : 'draw';
      const want = norm(wantRaw);
      const winning = market.selections.find((s) => {
        const n = norm(s.name);
        if (winner === 'DRAW') return n === 'draw' || n.startsWith('draw');
        return teamNameMatches(s.name, wantRaw) || n === want || n.includes(want) || want.includes(n);
      });
      if (!winning) return null;
      // Guard: a 2-way market (e.g. draw_no_bet) can't decide a draw.
      if (winner === 'DRAW' && !market.selections.some((s) => norm(s.name) === 'draw')) return null;
      return new Map(market.selections.map((s) => [s.id, s.id === winning.id]));
    }
    case 'double_chance': {
      const map = new Map<string, boolean>();
      for (const s of market.selections) {
        const covered = parseDoubleChance(s.name, game);
        if (!covered) return null;
        map.set(s.id, covered.has(winner));
      }
      return map;
    }
    case 'totals': {
      if (line == null) return null;
      const total = g.home + g.away;
      if (total === line) {
        // Push on integer line — void
        return new Map(market.selections.map((s) => [s.id, null]));
      }
      const overs = by((n) => n.startsWith('over'));
      const unders = by((n) => n.startsWith('under'));
      if (overs.length === 0 && unders.length === 0) return null;
      // Single-sided books (only Over or only Under offered) still grade
      // against the total; unknown third outcomes force manual review.
      if (overs.length + unders.length !== market.selections.length) return null;
      const overWins = total > line;
      return new Map(market.selections.map((s) => [s.id, overs.includes(s) ? overWins : !overWins]));
    }
    case 'team_totals': {
      if (line == null) return null;
      const map = new Map<string, boolean | null>();
      let any = false;
      for (const s of market.selections) {
        const n = norm(s.name);
        const hasOver = /\bover\b/.test(n);
        const hasUnder = /\bunder\b/.test(n);
        if (hasOver === hasUnder) continue;
        const mentionsHome = outcomeMentionsTeam(s.name, game.homeTeam);
        const mentionsAway = outcomeMentionsTeam(s.name, game.awayTeam);
        if (mentionsHome === mentionsAway) continue;
        const goals = mentionsHome ? g.home : g.away;
        let res: boolean | null;
        if (goals === line) res = null;
        else if (hasOver) res = goals > line;
        else res = goals < line;
        map.set(s.id, res);
        any = true;
      }
      if (!any) return null;
      return map;
    }
    case 'handicap': {
      if (line == null) return null;
      const homeNorm = norm(game.homeTeam);
      const awayNorm = norm(game.awayTeam);
      const m = new Map<string, boolean | null>();
      let any = false;
      for (const s of market.selections) {
        const n = norm(s.name);
        const isHome = teamNameMatches(s.name, game.homeTeam) || outcomeMentionsTeam(s.name, game.homeTeam) || n === homeNorm || n.includes(homeNorm) || homeNorm.includes(n);
        const isAway = teamNameMatches(s.name, game.awayTeam) || outcomeMentionsTeam(s.name, game.awayTeam) || n === awayNorm || n.includes(awayNorm) || awayNorm.includes(n);
        if (isHome && isAway) continue; // ambiguous — do not guess
        let selGoals: number | null = null;
        let oppGoals: number | null = null;
        if (isHome) {
          selGoals = g.home; oppGoals = g.away;
        } else if (isAway) {
          selGoals = g.away; oppGoals = g.home;
        } else {
          // Single-selection alias: if name is not a team, treat line as already applied to a generic side —
          // fallback: if we cannot map, skip this selection
          continue;
        }
        if (selGoals == null || oppGoals == null) continue;
        const adjusted = selGoals + line;
        let res: boolean | null;
        if (adjusted > oppGoals) res = true;
        else if (adjusted < oppGoals) res = false;
        else res = null; // push/void on integer handicap
        m.set(s.id, res);
        any = true;
      }
      if (!any) return null;
      return m;
    }
    case 'btts': {
      const yes = by((n) => n === 'yes' || n.startsWith('yes'));
      const no = by((n) => n === 'no' || n.startsWith('no'));
      if (yes.length === 0 || no.length === 0) return null;
      const both = g.home > 0 && g.away > 0;
      return new Map(market.selections.map((s) => [s.id, yes.includes(s) ? both : no.includes(s) ? !both : false]));
    }
    case 'correct_score': {
      const parsed = market.selections.map((s) => ({ s, score: parseScoreline(s.name) }));
      const bad = parsed.filter((p): p is { s: { id: string; name: string }; score: [number, number] | 'OTHER' } => p.score !== null);
      if (bad.length !== parsed.length) return null;
      const listed = bad.filter((p) => p.score !== 'OTHER').map((p) => p.score as [number, number]);
      const actual: [number, number] = [g.home, g.away];
      const map = new Map<string, boolean>();
      for (const { s, score } of bad) {
        if (score === 'OTHER') {
          map.set(s.id, !listed.some(([h, a]) => h === actual[0] && a === actual[1]));
        } else {
          map.set(s.id, score[0] === actual[0] && score[1] === actual[1]);
        }
      }
      return map;
    }
    case 'htft': {
      if (g.htHome == null || g.htAway == null) return null;
      const htW = sideWinner(g.htHome, g.htAway);
      const ftW = sideWinner(g.home, g.away);
      const toSide = (part: string): 'HOME' | 'AWAY' | 'DRAW' | null => {
        const n = norm(part);
        if (n === 'draw') return 'DRAW';
        if (outcomeMentionsTeam(part, game.homeTeam)) return 'HOME';
        if (outcomeMentionsTeam(part, game.awayTeam)) return 'AWAY';
        return null;
      };
      const map = new Map<string, boolean>();
      for (const s of market.selections) {
        const halves = s.name.split('/').map((x) => x.trim());
        if (halves.length !== 2) return null;
        const h1 = toSide(halves[0]);
        const h2 = toSide(halves[1]);
        if (!h1 || !h2) return null;
        map.set(s.id, h1 === htW && h2 === ftW);
      }
      return map;
    }
    default:
      return null;
  }
}

/** Provisional winner map for any score (live or finished) — used by UI details accordion. */
export function resolveMarketWinnersProvisional(market: { type: string; name: string; parameters: unknown; selections: { id: string; name: string }[] }, game: { homeTeam: string; awayTeam: string }, result: { homeFT: number | null; awayFT: number | null; homeHT?: number | null; awayHT?: number | null }): Map<string, boolean | null> | null {
  if (result.homeFT == null || result.awayFT == null) return null;
  // Reuse logic but without finished gate (HT carried through so half markets preview too)
  const fake: GameResult = { finished: true, matchStatus: 'PROVISIONAL', homeFT: result.homeFT, awayFT: result.awayFT, homeHT: result.homeHT ?? null, awayHT: result.awayHT ?? null, winner: result.homeFT > result.awayFT ? 'HOME' : result.homeFT < result.awayFT ? 'AWAY' : 'DRAW', source: 'none' };
  return resolveMarketWinners(market as Parameters<typeof resolveMarketWinners>[0], game, fake);
}

function computeBetProjection(bet: { stake: unknown; selections: { result: string; oddsAtPlacement: unknown; selection: { id: string; marketId: string; isWinning: boolean | null } }[] }, winnerMap: Map<string, Map<string, boolean | null> | null>): { result: 'WON' | 'LOST' | 'VOID' | 'PENDING' | 'UNKNOWN'; payout: number } {
  let anyLost = false;
  let allVoid = true;
  let oddsProduct = 1;
  let sawWon = false;
  for (const leg of bet.selections) {
    let r: string;
    if (leg.result !== 'PENDING') r = leg.result;
    else if (leg.selection.isWinning != null) r = leg.selection.isWinning ? 'WON' : 'LOST';
    else {
      const mw = winnerMap.get(leg.selection.marketId);
      if (!mw) return { result: 'UNKNOWN', payout: 0 };
      const v = mw.get(leg.selection.id);
      if (v === null) r = 'VOID';
      else if (v === undefined) r = 'LOST';
      else r = v ? 'WON' : 'LOST';
    }
    if (r === 'LOST') anyLost = true;
    if (r !== 'VOID') allVoid = false;
    if (r === 'WON') { sawWon = true; oddsProduct *= Number(leg.oddsAtPlacement); }
  }
  const stake = Number(bet.stake);
  if (anyLost) return { result: 'LOST', payout: 0 };
  if (allVoid) return { result: 'VOID', payout: stake };
  if (sawWon) return { result: 'WON', payout: round2(stake * oddsProduct) };
  return { result: 'PENDING', payout: 0 };
}

async function buildSettlement(gameId: string) {
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: {
      competition: { include: { sport: true } },
      markets: { include: { selections: true } },
    },
  });
  if (!game) throw new ApiError(404, 'Game not found');

  const result = await resolveGameResult(gameId);

  const winnerMap = new Map<string, Map<string, boolean | null> | null>();
  const autoSettleable: string[] = [];
  const needsManual: string[] = [];
  for (const m of game.markets) {
    if (m.status === 'SETTLED') continue;
    const w = resolveMarketWinners(m, game, result);
    winnerMap.set(m.id, w);
    if (w) autoSettleable.push(m.name);
    else {
      const reason = result.finished ? manualReason(m) : null;
      needsManual.push(reason ? `${m.name} (${reason})` : m.name);
    }
  }

  const bets = await prisma.bet.findMany({
    where: { selections: { some: { selection: { market: { gameId } } } } },
    include: {
      user: { select: { id: true, email: true, name: true } },
      selections: { include: { selection: { select: { id: true, name: true, marketId: true, isWinning: true, market: { select: { id: true, name: true, type: true } } } } } },
    },
    orderBy: { placedAt: 'asc' },
  });

  let totalStaked = 0;
  let projectedPayout = 0;
  let paidOut = 0;
  const betViews = bets.map((b) => {
    const stake = Number(b.stake);
    totalStaked += stake;
    const proj = computeBetProjection(b as unknown as Parameters<typeof computeBetProjection>[0], winnerMap);
    // Actual payable: the graded (void-adjusted) payout when set, else the placement
    // potential for fully-won tickets and stake for voids.
    const effective = Number(b.settledPayout) > 0 ? Number(b.settledPayout) : b.status === 'WON' ? Number(b.potentialPayout) : stake;
    const payout = b.status === 'WON' || b.status === 'VOID' ? effective : proj.payout;
    if ((b.status === 'WON' || b.status === 'VOID') || proj.result === 'WON' || proj.result === 'VOID') projectedPayout += payout;
    if (b.payoutStatus === 'PAID' && (b.status === 'WON' || b.status === 'VOID')) {
      paidOut += effective;
    }
    return {
      id: b.id,
      type: b.type,
      stake,
      totalOdds: Number(b.totalOdds),
      potentialPayout: Number(b.potentialPayout),
      status: b.status,
      projectedResult: proj.result,
      projectedPayout: payout,
      payoutStatus: b.payoutStatus,
      settledPayout: Number(b.settledPayout),
      placedAt: b.placedAt,
      settledAt: b.settledAt,
      user: b.user,
      legs: b.selections.map((l) => ({
        id: l.id,
        selectionId: l.selection.id,
        selectionName: l.selection.name,
        marketName: l.selection.market.name,
        marketType: l.selection.market.type,
        odds: Number(l.oddsAtPlacement),
        result: l.result,
      })),
    };
  });

  const counts = {
    total: bets.length,
    pending: bets.filter((b) => b.status === 'PENDING').length,
    won: bets.filter((b) => b.status === 'WON').length,
    lost: bets.filter((b) => b.status === 'LOST').length,
    void: bets.filter((b) => b.status === 'VOID').length,
  };

  // Markets with provisional winners for the accordion details (live or finished)
  const marketsView = game.markets.map((m) => {
    const w = winnerMap.get(m.id);
    const prov = result.homeFT != null && result.awayFT != null ? resolveMarketWinnersProvisional(m, game, { homeFT: result.homeFT, awayFT: result.awayFT, homeHT: result.homeHT, awayHT: result.awayHT }) : null;
    const eff = w ?? prov;
    return {
      id: m.id,
      name: m.name,
      type: m.type,
      status: m.status,
      parameters: m.parameters as { marketKey?: string; line?: number | null } | null,
      selections: m.selections.map((s) => ({
        id: s.id,
        name: s.name,
        odds: Number(s.odds),
        isWinning: s.isWinning as boolean | null,
        provisional: eff ? (eff.has(s.id) ? eff.get(s.id) ?? null : null) : null,
      })),
    };
  });

  return {
    game: {
      id: game.id,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      startTime: game.startTime,
      status: game.status,
      isPublished: game.isPublished,
      externalEventId: game.externalEventId,
      lastOddsFetchAt: game.lastOddsFetchAt ?? (() => {
        const spec = (game.specifications ?? {}) as { lastFetchedAt?: unknown };
        return typeof spec.lastFetchedAt === 'string' ? new Date(spec.lastFetchedAt) : null;
      })(),
      competition: game.competition ? { id: game.competition.id, name: game.competition.name, country: game.competition.country, sport: game.competition.sport?.name ?? null } : null,
    },
    result,
    canSettle: result.finished && autoSettleable.length > 0 && bets.some((b) => b.status === 'PENDING'),
    settleableMarkets: autoSettleable,
    manualMarkets: needsManual,
    bets: betViews,
    markets: marketsView,
    totals: {
      totalStaked: round2(totalStaked),
      projectedPayout: round2(projectedPayout),
      paidOut: round2(paidOut),
      profit: round2(totalStaked - projectedPayout),
    },
    counts,
  };
}

export type Settlement = Awaited<ReturnType<typeof buildSettlement>>;

export const getSettlement = (gameId: string) => buildSettlement(gameId);

/**
 * Calculate step for the admin bet-games page (finished games only): grades the
 * legs that belong to THIS game as WON/LOST (/VOID) on every PENDING ticket and
 * flips tickets with a lost leg to LOST. Legs on other games are never touched,
 * and no money moves — WON tickets are credited by the separate settle-payments
 * step. Markets that cannot auto-resolve are skipped for manual grading.
 */
export async function calculateGameSettlement(gameId: string, adminId?: string) {
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: { markets: { include: { selections: true } } },
  });
  if (!game) throw new ApiError(404, 'Game not found');

  const result = await resolveGameResult(gameId);
  if (!result.finished) throw new ApiError(400, 'Game is not finished yet — cannot calculate. Waiting for football-data result.');

  let legsGraded = 0;
  let betsMarkedLost = 0;

  const pendingBets = await prisma.bet.findMany({
    where: { status: 'PENDING', selections: { some: { selection: { market: { gameId } } } } },
    include: { selections: { include: { selection: { select: { id: true, marketId: true } } } } },
  });

  for (const b of pendingBets) {
    const legUpdates: { id: string; result: 'WON' | 'LOST' | 'VOID' }[] = [];
    for (const leg of b.selections) {
      if (leg.result !== 'PENDING') continue; // manual grades + other games' legs stay as they are
      const market = game.markets.find((m) => m.id === leg.selection.marketId);
      if (!market || market.gameId !== gameId || market.status === 'SETTLED') continue;
      const winners = resolveMarketWinners(market, game, result);
      if (!winners) continue; // needs manual settlement
      const v = winners.get(leg.selectionId);
      legUpdates.push({ id: leg.id, result: v === null ? 'VOID' : v ? 'WON' : 'LOST' });
    }
    if (legUpdates.length === 0) continue;
    await prisma.$transaction(async (tx) => {
      for (const lu of legUpdates) {
        await tx.betSelection.update({ where: { id: lu.id }, data: { result: lu.result } });
      }
      legsGraded += legUpdates.length;
      // A single lost leg kills the whole ticket — mark it now; payout stays for settle-payments
      if (legUpdates.some((lu) => lu.result === 'LOST')) {
        await tx.bet.update({ where: { id: b.id }, data: { status: 'LOST' } });
        betsMarkedLost += 1;
      }
    });
  }

  const settlement = await buildSettlement(gameId);
  const profit = round2(settlement.totals.totalStaked - settlement.totals.projectedPayout);
  const out = {
    ...settlement,
    meta: {
      resultFinished: result.finished,
      marketsResolved: 0,
      previewWon: 0,
      previewLost: 0,
      previewVoid: 0,
      previewUndecided: 0,
      previewPayout: 0,
      profit,
      legsGraded,
      betsMarkedLost,
    },
  };

  if (adminId && (legsGraded > 0 || betsMarkedLost > 0)) {
    await prisma.adminActionLog.create({
      data: { userId: adminId, action: 'GAME_CALCULATED', targetType: 'Game', targetId: gameId, metadata: { legsGraded, betsMarkedLost } as never },
    });
  }
  return out;
}

/** Full football-data.org details for a game (live fetch by match id + stored GameScore snapshot). */
export async function getFootballGameDetails(gameId: string) {
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: {
      score: true,
      competition: { include: { sport: true } },
      stagedGame: { select: { footballDataMatchId: true, footballDataStatus: true } },
    },
  });
  if (!game) throw new ApiError(404, 'Game not found');

  const spec = (game.specifications ?? {}) as Record<string, unknown>;
  const matchId =
    (typeof spec.footballDataMatchId === 'number' ? spec.footballDataMatchId : null) ??
    game.score?.footballDataMatchId ??
    game.stagedGame?.footballDataMatchId ??
    null;

  let match: unknown = null;
  let fetched = false;
  if (matchId != null) {
    try {
      match = await fetchFootballDataMatch(matchId);
      fetched = true;
    } catch {
      // fall back to whatever is stored locally
    }
  }

  return {
    game: {
      id: game.id,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      startTime: game.startTime,
      status: game.status,
      externalEventId: game.externalEventId,
      isPublished: game.isPublished,
      competition: game.competition ? { id: game.competition.id, name: game.competition.name, country: game.competition.country, sport: game.competition.sport?.name ?? null } : null,
    },
    matchId,
    fetched,
    match,
    storedScore: game.score
      ? {
          footballDataMatchId: game.score.footballDataMatchId,
          winner: game.score.winner,
          duration: game.score.duration,
          homeScoreHT: game.score.homeScoreHT,
          awayScoreHT: game.score.awayScoreHT,
          homeScoreRegularTime: game.score.homeScoreRegularTime,
          awayScoreRegularTime: game.score.awayScoreRegularTime,
          homeScoreFT: game.score.homeScoreFT,
          awayScoreFT: game.score.awayScoreFT,
          homeScoreExtraTime: game.score.homeScoreExtraTime,
          awayScoreExtraTime: game.score.awayScoreExtraTime,
          homeScorePenalties: game.score.homeScorePenalties,
          awayScorePenalties: game.score.awayScorePenalties,
          status: game.score.status,
          fetchedAt: game.score.fetchedAt,
        }
      : null,
  };
}

/**
 * Settle a single bet independent of the bulk game settle.
 * Accurately transfers money, sets bet status to WON/LOST/VOID and bumps payoutStatus.
 * Uses the current football-data result (must be finished).
 */
export async function settleSingleBet(gameId: string, betId: string, adminId?: string) {
  const bet = await prisma.bet.findUnique({
    where: { id: betId },
    include: { selections: { include: { selection: { include: { market: { include: { game: true } } } } } } },
  });
  if (!bet) throw new ApiError(404, 'Bet not found');
  if (bet.status !== 'PENDING') throw new ApiError(400, `Bet already settled as ${bet.status}`);
  // Verify the bet belongs to this game (at least one leg on this game)
  const gameIds = new Set(bet.selections.map((l) => l.selection.market.gameId));
  if (!gameIds.has(gameId)) throw new ApiError(400, 'Bet does not belong to this game');

  const game = await prisma.game.findUnique({ where: { id: gameId }, include: { markets: { include: { selections: true } } } });
  if (!game) throw new ApiError(404, 'Game not found');
  const result = await resolveGameResult(gameId);
  if (!result.finished) throw new ApiError(400, 'Game is not finished yet — cannot settle. Waiting for football-data result.');

  // Pre-compute leg results (pure reads)
  const legUpdates = bet.selections.map((leg) => {
    const market = game.markets.find((m) => m.id === leg.selection.marketId);
    if (!market) throw new ApiError(404, `Market ${leg.selection.marketId} not found for this game`);
    const winners = resolveMarketWinners(market, game, result);
    if (!winners) throw new ApiError(400, `Market "${market.name}" cannot be auto-settled — needs manual settlement`);
    const v = winners.get(leg.selectionId);
    return {
      id: leg.id,
      selectionId: leg.selectionId,
      result: (v === null ? 'VOID' : v ? 'WON' : 'LOST') as 'WON' | 'LOST' | 'VOID',
      isWinning: (v === true ? true : v === false ? false : null) as boolean | null,
    };
  });

  // ONE transaction: leg results + grading + balance credit + ledger row commit
  // together (gradeBetIfComplete uses this same tx client). Manual per-bet
  // settlement => attribute the acting admin on the bet itself.
  const graded = await prisma.$transaction(async (tx) => {
    for (const lu of legUpdates) {
      await tx.betSelection.update({ where: { id: lu.id }, data: { result: lu.result } });
      if (lu.isWinning !== null) {
        const sel = await tx.selection.findUnique({ where: { id: lu.selectionId } });
        if (sel && sel.isWinning == null) {
          await tx.selection.update({ where: { id: lu.selectionId }, data: { isWinning: lu.isWinning } });
        }
      }
    }
    const g = await betService.gradeBetIfComplete(tx, betId, adminId ? { settledById: adminId } : undefined);
    if (!g) throw new ApiError(500, 'Bet could not be graded after all legs were decided');
    return g;
  }, { timeout: 20000, maxWait: 10000 });

  if (adminId) {
    await prisma.adminActionLog.create({
      data: { userId: adminId, action: 'BET_SETTLED_SINGLE', targetType: 'Bet', targetId: betId, metadata: { gameId, finalStatus: graded.status, payout: graded.payout, legs: legUpdates.map((l) => ({ id: l.id, result: l.result })) } as never },
    });
  }

  // Mark market SETTLED if all its selections have been decided (optional)
  for (const leg of bet.selections) {
    const marketId = leg.selection.marketId;
    const sels = await prisma.selection.findMany({ where: { marketId } });
    if (sels.every((s) => s.isWinning !== null)) {
      await prisma.market.update({ where: { id: marketId }, data: { status: 'SETTLED' } }).catch(() => {});
    }
  }

  return buildSettlement(gameId);
}

/**
 * Settle every auto-resolvable market of a finished game by marking each selection's
 * outcome via marketService.settleSelection (which recomputes + credits bets).
 * Newly WON bets get payoutStatus SUBMITTED so admin can then mark them PAID.
 */
export async function settleGame(gameId: string, adminId?: string) {
  const game = await prisma.game.findUnique({ where: { id: gameId }, include: { markets: { include: { selections: true } } } });
  if (!game) throw new ApiError(404, 'Game not found');
  const result = await resolveGameResult(gameId);
  if (!result.finished) throw new ApiError(400, 'Game is not finished yet — cannot settle. Waiting for football-data result.');

  let settledMarkets = 0;
  let skippedMarkets = 0;
  for (const m of game.markets) {
    if (m.status === 'SETTLED') continue;
    const winners = resolveMarketWinners(m, game, result);
    if (!winners) { skippedMarkets++; continue; }
    for (const s of m.selections) {
      try {
        const v = winners.get(s.id);
        await marketService.settleSelection(s.id, v === true ? true : v === false ? false : null);
      } catch (e) {
        if (e instanceof ApiError && /already settled/i.test(e.message)) continue;
        throw e;
      }
    }
    settledMarkets++;
  }

  // Mark newly WON/VOID bets SUBMITTED (gradeBetIfComplete already wrote the actual
  // settledPayout incl. void-leg adjustment; backfill only for pre-existing rows).
  const newlySettled = await prisma.bet.findMany({
    where: { status: { in: ['WON', 'VOID'] }, payoutStatus: 'PENDING', selections: { some: { selection: { market: { gameId } } } } },
    select: { id: true, status: true, potentialPayout: true, stake: true, settledPayout: true },
  });
  for (const b of newlySettled) {
    const settledPayout = Number(b.settledPayout) > 0
      ? Number(b.settledPayout)
      : b.status === 'WON' ? round2(b.potentialPayout) : round2(b.stake);
    await prisma.bet.update({ where: { id: b.id }, data: { payoutStatus: 'SUBMITTED', settledPayout } });
  }

  if (adminId) {
    await prisma.adminActionLog.create({
      data: { userId: adminId, action: 'GAME_SETTLED', targetType: 'Game', targetId: gameId, metadata: { settledMarkets, skippedMarkets, score: `${result.homeFT}-${result.awayFT}`, winner: result.winner } as never },
    });
  }
  const s = await buildSettlement(gameId);
  return { ...s, meta: { settledMarkets, skippedMarkets } };
}

/**
 * Confirmed payout step (admin pressed "Settle payment" + confirmed):
 * grades + credits via settleGame(), then notifies ONLY the winning users.
 * Idempotent: only bets that were PENDING before this run and are WON after
 * get a notification — re-pressing notifies nobody new.
 */
export async function settleGamePayments(gameId: string, adminId?: string) {
  const pendingBefore = await prisma.bet.findMany({
    where: { status: 'PENDING', selections: { some: { selection: { market: { gameId } } } } },
    select: { id: true },
  });
  const pendingIds = new Set(pendingBefore.map((b) => b.id));

  const settled = await settleGame(gameId, adminId);

  let notified = 0;
  if (pendingIds.size > 0) {
    const newlyWon = await prisma.bet.findMany({
      where: { id: { in: [...pendingIds] }, status: 'WON' },
      select: { id: true, userId: true, stake: true, settledPayout: true, potentialPayout: true },
    });
    const game = await prisma.game.findUnique({ where: { id: gameId }, select: { homeTeam: true, awayTeam: true } });
    const fixture = game ? `${game.homeTeam} vs ${game.awayTeam}` : 'your game';
    for (const b of newlyWon) {
      const amount = Number(b.settledPayout) > 0 ? Number(b.settledPayout) : Number(b.potentialPayout);
      await notify({
        audience: 'USER',
        userId: b.userId,
        type: 'BET_WON',
        title: `You won ETB ${round2(amount).toFixed(2)}!`,
        message: `${fixture} — stake ETB ${Number(b.stake).toFixed(2)} paid out`,
        linkUrl: '/my-bets',
      });
      notified++;
    }
  }

  if (adminId) {
    await prisma.adminActionLog.create({
      data: { userId: adminId, action: 'GAME_PAYOUT_SETTLED', targetType: 'Game', targetId: gameId, metadata: { notified } as never },
    });
  }
  return { ...settled, meta: { ...settled.meta, notified } };
}

export async function markPayout(gameId: string, payoutStatus: 'SUBMITTED' | 'PAID' | 'PENDING', adminId?: string) {
  const bets = await prisma.bet.findMany({
    where: { status: { in: ['WON', 'VOID'] }, selections: { some: { selection: { market: { gameId } } } } },
    select: { id: true, status: true, potentialPayout: true, stake: true, settledPayout: true },
  });
  if (bets.length === 0) throw new ApiError(404, 'No settled (won/void) bets for this game to mark');

  for (const b of bets) {
    const amount = Number(b.settledPayout) > 0 ? round2(b.settledPayout) : b.status === 'WON' ? round2(b.potentialPayout) : round2(b.stake);
    await prisma.bet.update({
      where: { id: b.id },
      data: {
        payoutStatus,
        settledPayout: payoutStatus === 'PENDING' ? 0 : amount,
        paidOutAt: payoutStatus === 'PAID' ? new Date() : null,
      },
    });
  }

  if (adminId) {
    await prisma.adminActionLog.create({ data: { userId: adminId, action: `BET_PAYOUT_${payoutStatus}`, targetType: 'Game', targetId: gameId, metadata: { payoutStatus, betCount: bets.length } as never } });
  }
  return buildSettlement(gameId);
}

/** List published games with settlement-relevant aggregates for the "Bet Games" screen. */
export async function listBetGames() {
  const games = await prisma.game.findMany({
    where: { isPublished: true },
    include: { competition: { include: { sport: true } }, score: { select: { footballDataMatchId: true, homeScoreFT: true, awayScoreFT: true, status: true } } },
    orderBy: { startTime: 'asc' },
  });
  const gameIds = games.map((g) => g.id);

  const bets = gameIds.length
    ? await prisma.bet.findMany({
        where: { selections: { some: { selection: { market: { gameId: { in: gameIds } } } } } },
        select: { stake: true, status: true, potentialPayout: true, selections: { select: { selection: { select: { market: { select: { gameId: true } } } } } } },
      })
    : [];

  const perGame = new Map<string, { placed: number; staked: number; payout: number; settled: number }>();
  for (const g of gameIds) perGame.set(g, { placed: 0, staked: 0, payout: 0, settled: 0 });
  for (const b of bets) {
    const gamesInBet = new Set<string>();
    for (const leg of b.selections) {
      const gid = leg.selection?.market?.gameId;
      if (gid && perGame.has(gid)) gamesInBet.add(gid);
    }
    for (const gid of gamesInBet) {
      const agg = perGame.get(gid)!;
      agg.placed += 1;
      agg.staked += Number(b.stake);
      if (b.status === 'WON') agg.payout += Number(b.potentialPayout);
      if (b.status !== 'PENDING') agg.settled += 1;
    }
  }

  return games.map((g) => {
    const agg = perGame.get(g.id) ?? { placed: 0, staked: 0, payout: 0, settled: 0 };
    return {
      id: g.id,
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
      startTime: g.startTime,
      status: g.status,
      isPublished: g.isPublished,
      externalEventId: g.externalEventId,
      footballDataMatchId: (g.specifications as { footballDataMatchId?: number } | null)?.footballDataMatchId ?? g.score?.footballDataMatchId ?? null,
      score: g.score ? { home: g.score.homeScoreFT, away: g.score.awayScoreFT } : null,
      competition: g.competition ? { name: g.competition.name, sport: g.competition.sport?.name ?? null } : null,
      betCount: agg.placed,
      totalStaked: round2(agg.staked),
      totalPayout: round2(agg.payout),
      settledCount: agg.settled,
    };
  });
}
