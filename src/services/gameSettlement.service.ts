import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import * as marketService from './market.service';
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

/**
 * Determine winning selections for a market given a finished result.
 * Returns a Map<selectionId, isWinning> when resolvable, or null if this market
 * cannot be auto-settled (needs manual settlement). isWinning = null means push/void.
 */
function resolveMarketWinners(market: { type: string; name: string; parameters: unknown; selections: { id: string; name: string }[] }, game: { homeTeam: string; awayTeam: string }, result: GameResult): Map<string, boolean | null> | null {
  if (!result.finished || result.homeFT == null || result.awayFT == null) return null;
  const total = result.homeFT + result.awayFT;
  const params = (market.parameters ?? {}) as { line?: unknown };
  const line = typeof params.line === 'number' ? params.line : null;
  const by = (pred: (name: string) => boolean) => market.selections.filter((s) => pred(norm(s.name)));

  switch (market.type) {
    case 'MATCH_WINNER': {
      if (!result.winner) return null;
      const want = result.winner === 'HOME' ? norm(game.homeTeam) : result.winner === 'AWAY' ? norm(game.awayTeam) : 'draw';
      const winning = market.selections.find((s) => norm(s.name) === want || norm(s.name).includes(want) || want.includes(norm(s.name)));
      if (!winning) return null;
      // Guard: a 2-way market (e.g. draw_no_bet) can't decide a draw.
      if (result.winner === 'DRAW' && !market.selections.some((s) => norm(s.name) === 'draw')) return null;
      return new Map(market.selections.map((s) => [s.id, s.id === winning.id]));
    }
    case 'OVER_UNDER': {
      if (line == null) return null;
      if (total === line) {
        // Push on integer line — void
        return new Map(market.selections.map((s) => [s.id, null]));
      }
      const overs = by((n) => n.startsWith('over'));
      const unders = by((n) => n.startsWith('under'));
      if (overs.length === 0 || unders.length === 0) return null;
      const overWins = total > line;
      return new Map(market.selections.map((s) => [s.id, overs.includes(s) ? overWins : unders.includes(s) ? !overWins : false]));
    }
    case 'BOTH_TEAMS_TO_SCORE': {
      const yes = by((n) => n === 'yes' || n.startsWith('yes'));
      const no = by((n) => n === 'no' || n.startsWith('no'));
      if (yes.length === 0 || no.length === 0) return null;
      const both = result.homeFT > 0 && result.awayFT > 0;
      return new Map(market.selections.map((s) => [s.id, yes.includes(s) ? both : no.includes(s) ? !both : false]));
    }
    case 'HANDICAP': {
      if (line == null) return null;
      const homeNorm = norm(game.homeTeam);
      const awayNorm = norm(game.awayTeam);
      const m = new Map<string, boolean | null>();
      let any = false;
      for (const s of market.selections) {
        const n = norm(s.name);
        let selGoals: number | null = null;
        let oppGoals: number | null = null;
        if (n === homeNorm || n.includes(homeNorm) || homeNorm.includes(n)) {
          selGoals = result.homeFT; oppGoals = result.awayFT;
        } else if (n === awayNorm || n.includes(awayNorm) || awayNorm.includes(n)) {
          selGoals = result.awayFT; oppGoals = result.homeFT;
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
    default:
      return null;
  }
}

/** Provisional winner map for any score (live or finished) — used by UI details accordion. */
export function resolveMarketWinnersProvisional(market: { type: string; name: string; parameters: unknown; selections: { id: string; name: string }[] }, game: { homeTeam: string; awayTeam: string }, result: { homeFT: number | null; awayFT: number | null }): Map<string, boolean | null> | null {
  if (result.homeFT == null || result.awayFT == null) return null;
  // Reuse logic but without finished gate
  const fake: GameResult = { finished: true, matchStatus: 'PROVISIONAL', homeFT: result.homeFT, awayFT: result.awayFT, homeHT: null, awayHT: null, winner: result.homeFT > result.awayFT ? 'HOME' : result.homeFT < result.awayFT ? 'AWAY' : 'DRAW', source: 'none' };
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
    else needsManual.push(m.name);
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
    const payout = b.status === 'WON' ? Number(b.potentialPayout) : b.status === 'VOID' ? stake : proj.payout;
    if ((b.status === 'WON' || b.status === 'VOID') || proj.result === 'WON' || proj.result === 'VOID') projectedPayout += payout;
    if (b.payoutStatus === 'PAID' && (b.status === 'WON' || b.status === 'VOID')) {
      paidOut += b.status === 'WON' ? Number(b.potentialPayout) : stake;
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
    const prov = result.homeFT != null && result.awayFT != null ? resolveMarketWinnersProvisional(m, game, { homeFT: result.homeFT, awayFT: result.awayFT }) : null;
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
 * Recalculate the game from the current result and PERSIST Selection.isWinning
 * for every auto-resolvable market (finished games only). No balances move and
 * markets are not flipped to SETTLED — that stays with settleGame().
 */
export async function calculateGameSettlement(gameId: string) {
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: { markets: { include: { selections: true } } },
  });
  if (!game) throw new ApiError(404, 'Game not found');

  const result = await resolveGameResult(gameId);
  let selectionsUpdated = 0;
  let marketsResolved = 0;

  if (result.finished) {
    for (const m of game.markets) {
      const winners = resolveMarketWinners(m, game, result);
      if (!winners) continue;
      marketsResolved++;
      for (const s of m.selections) {
        const v = winners.get(s.id);
        const shouldBeWinning = v === true ? true : v === false ? false : null;
        // For push/void (null) we keep isWinning null — VOID is handled via winnerMap at payout time
        if (s.isWinning !== shouldBeWinning) {
          await prisma.selection.update({ where: { id: s.id }, data: { isWinning: shouldBeWinning } });
          selectionsUpdated++;
        }
      }
    }
  }

  const settlement = await buildSettlement(gameId);
  return { ...settlement, meta: { resultFinished: result.finished, marketsResolved, selectionsUpdated } };
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

  // For each leg, resolve its market's winner map
  for (const leg of bet.selections) {
    const market = game.markets.find((m) => m.id === leg.selection.marketId);
    if (!market) throw new ApiError(404, `Market ${leg.selection.marketId} not found for this game`);
    const winners = resolveMarketWinners(market, game, result);
    if (!winners) throw new ApiError(400, `Market "${market.name}" cannot be auto-settled — needs manual settlement`);

    const v = winners.get(leg.selectionId);
    const isWinning = v === true ? true : v === false ? false : null;

    // Update BetSelection result for THIS bet only (not global selection settle)
    const newResult = isWinning === null ? 'VOID' : isWinning ? 'WON' : 'LOST';
    await prisma.betSelection.update({ where: { id: leg.id }, data: { result: newResult } });

    // Also persist Selection.isWinning when it's a clear win/loss (helps future projections)
    if (isWinning !== null) {
      const sel = await prisma.selection.findUnique({ where: { id: leg.selectionId } });
      if (sel && sel.isWinning == null) {
        await prisma.selection.update({ where: { id: leg.selectionId }, data: { isWinning } });
      }
    }
  }

  // Recompute bet status + transfer money atomically
  const updatedLegs = await prisma.betSelection.findMany({ where: { betId } });
  let finalStatus: 'WON' | 'LOST' | 'VOID';
  let payout = 0;
  if (updatedLegs.some((l) => l.result === 'LOST')) {
    finalStatus = 'LOST';
  } else if (updatedLegs.every((l) => l.result === 'VOID')) {
    finalStatus = 'VOID';
    payout = Number(bet.stake);
  } else if (updatedLegs.some((l) => l.result === 'WON')) {
    finalStatus = 'WON';
    const wonOdds = updatedLegs.filter((l) => l.result === 'WON').reduce((acc, l) => acc * Number(l.oddsAtPlacement), 1);
    payout = round2(Number(bet.stake) * (wonOdds || 1));
  } else {
    throw new ApiError(500, 'Unexpected bet leg state after settle');
  }

  const updatedBet = await prisma.$transaction(async (tx) => {
    let balanceAfter: number | null = null;
    if (finalStatus === 'WON' || finalStatus === 'VOID') {
      const user = await tx.user.findUnique({ where: { id: bet.userId } });
      if (user) {
        balanceAfter = round2(Number(user.balance) + payout);
        await tx.user.update({ where: { id: bet.userId }, data: { balance: { increment: payout } } });
        await tx.transaction.create({
          data: {
            userId: bet.userId,
            type: finalStatus === 'WON' ? 'BET_WON' : 'BET_REFUND',
            amount: payout,
            balanceAfter,
            reference: bet.id,
          },
        });
      }
    }
    const data: Record<string, unknown> = { status: finalStatus, settledAt: new Date() };
    if (finalStatus === 'WON') {
      (data as { payoutStatus: string }).payoutStatus = 'SUBMITTED';
      (data as { settledPayout: number }).settledPayout = payout;
    } else if (finalStatus === 'VOID') {
      (data as { payoutStatus: string }).payoutStatus = 'SUBMITTED';
      (data as { settledPayout: number }).settledPayout = payout;
    }
    return tx.bet.update({ where: { id: betId }, data: data as never });
  }, { timeout: 20000, maxWait: 10000 });

  if (adminId) {
    await prisma.adminActionLog.create({
      data: { userId: adminId, action: 'BET_SETTLED_SINGLE', targetType: 'Bet', targetId: betId, metadata: { gameId, finalStatus, payout, legs: updatedLegs.map((l) => ({ id: l.id, result: l.result })) } as never },
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

  // Mark newly WON/VOID bets as SUBMITTED and record settledPayout for payout tracking
  const newlySettled = await prisma.bet.findMany({
    where: { status: { in: ['WON', 'VOID'] }, payoutStatus: 'PENDING', selections: { some: { selection: { market: { gameId } } } } },
    select: { id: true, status: true, potentialPayout: true, stake: true },
  });
  for (const b of newlySettled) {
    const settledPayout = b.status === 'WON' ? round2(b.potentialPayout) : round2(b.stake);
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

export async function markPayout(gameId: string, payoutStatus: 'SUBMITTED' | 'PAID' | 'PENDING', adminId?: string) {
  const bets = await prisma.bet.findMany({
    where: { status: { in: ['WON', 'VOID'] }, selections: { some: { selection: { market: { gameId } } } } },
    select: { id: true, status: true, potentialPayout: true, stake: true },
  });
  if (bets.length === 0) throw new ApiError(404, 'No settled (won/void) bets for this game to mark');

  for (const b of bets) {
    const amount = b.status === 'WON' ? round2(b.potentialPayout) : round2(b.stake);
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
