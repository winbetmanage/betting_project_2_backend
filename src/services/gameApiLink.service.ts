import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import { Prisma } from '@prisma/client';
import { getFootballDataMatchDetailUrl, footballDataFetchOptions } from '../../codes';
import {
  isoDay,
  fetchFdMatchesByDay,
  fetchEvents,
  summarizeMatch,
  choiceForCompetitionName,
  mapFootballDataStatus,
  teamHasFdMapping,
  fdTeamMatchesTeam,
} from './stagedGames.service';
import type { SportChoice, FdMatch } from './stagedGames.service';

type TeamLite = { id: string; fullName: string; oddsApiName: string | null; footballDataName: string | null; footballDataTeamId: number | null };

function normTokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function namesLooseMatch(a: string, b: string): boolean {
  const A = normTokens(a);
  const B = normTokens(b);
  if (!A.length || !B.length) return false;
  const sa = A.join(' ');
  const sb = B.join(' ');
  if (sa === sb) return true;
  const [small, large] = A.length <= B.length ? [A, B] : [B, A];
  if (small.every((t) => large.includes(t))) return true;
  return sa.includes(sb) || sb.includes(sa);
}

async function loadGame(id: string) {
  const game = await prisma.game.findUnique({
    where: { id },
    include: {
      competition: { select: { id: true, name: true, country: true } },
      score: { select: { footballDataMatchId: true, status: true } },
      stagedGame: { select: { id: true, footballDataMatchId: true, gameId: true } },
    },
  });
  if (!game) throw new ApiError(404, 'Game not found');
  return game;
}

function gameFootballDataMatchId(game: {
  specifications: Prisma.JsonValue;
  score: { footballDataMatchId: number } | null;
  stagedGame: { footballDataMatchId: number | null } | null;
}): number | null {
  const spec = (game.specifications ?? {}) as Record<string, unknown>;
  if (typeof spec.footballDataMatchId === 'number') return spec.footballDataMatchId;
  return game.score?.footballDataMatchId ?? game.stagedGame?.footballDataMatchId ?? null;
}

async function resolveTeam(teamId: string | null | undefined, gameName: string): Promise<TeamLite | null> {
  if (teamId) {
    const t = await prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true, fullName: true, oddsApiName: true, footballDataName: true, footballDataTeamId: true },
    });
    if (t) return t;
  }
  const byName = await prisma.team.findFirst({
    where: { OR: [{ fullName: gameName }, ...(gameName ? [{ oddsApiName: gameName }] : [])] },
    select: { id: true, fullName: true, oddsApiName: true, footballDataName: true, footballDataTeamId: true },
  });
  return byName;
}

export const getGameApiLinks = async (gameId: string) => {
  const game = await loadGame(gameId);
  const spec = (game.specifications ?? {}) as Record<string, unknown>;
  return {
    gameId: game.id,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    startTime: game.startTime,
    competition: game.competition,
    externalEventId: game.externalEventId,
    sportKey: typeof spec.sport_key === 'string' ? spec.sport_key : null,
    footballDataMatchId: gameFootballDataMatchId(game),
    fromScoreOrStaged: typeof spec.footballDataMatchId !== 'number' && gameFootballDataMatchId(game) != null,
  };
};

/** Game has an odds-api event (or at least teams+date) → search football-data fixtures for the match. */
export const findFootballDataForGame = async (gameId: string) => {
  const game = await loadGame(gameId);
  const choice = choiceForCompetitionName(game.competition?.name);
  const day = isoDay(new Date(game.startTime));

  const [homeTeam, awayTeam] = await Promise.all([
    resolveTeam(game.homeTeamId, game.homeTeam),
    resolveTeam(game.awayTeamId, game.awayTeam),
  ]);

  const searched = {
    choice,
    day,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    homeMapped: !!homeTeam && teamHasFdMapping(homeTeam),
    awayMapped: !!awayTeam && teamHasFdMapping(awayTeam),
    fixturesThatDay: 0,
  };

  const matches = await fetchFdMatchesByDay(choice, day);
  const sameDay = matches.filter((m) => m.utcDate && isoDay(new Date(m.utcDate)) === day);
  searched.fixturesThatDay = sameDay.length;

  const match = sameDay.find(
    (m) => fdTeamMatch(m, homeTeam, game.homeTeam, 'home') && fdTeamMatch(m, awayTeam, game.awayTeam, 'away')
  );
  const dayFixtures = sameDay.map(summarizeMatch);
  if (!match) return { found: false, searched, dayFixtures };
  return { found: true, match: summarizeMatch(match), searched, dayFixtures };
};

function fdTeamMatch(m: FdMatch, team: TeamLite | null, gameName: string, side: 'home' | 'away'): boolean {
  const fdTeam = side === 'home' ? m.homeTeam : m.awayTeam;
  if (team && teamHasFdMapping(team)) return fdTeamMatchesTeam(fdTeam, team);
  return namesLooseMatch(fdTeam?.name ?? '', gameName);
}

/** Game has a football-data link (or teams+date) → search The Odds API event feed. */
export const findOddsEventsForGame = async (gameId: string) => {
  const game = await loadGame(gameId);
  const choice = choiceForCompetitionName(game.competition?.name);
  const events = await fetchEvents(choice, false);

  const day = isoDay(new Date(game.startTime));
  let candidates = events.filter(
    (e) =>
      isoDay(new Date(e.commence_time)) === day &&
      namesLooseMatch(e.home_team, game.homeTeam) &&
      namesLooseMatch(e.away_team, game.awayTeam)
  );

  // Widen: ±1 day if exact-day has nothing
  if (candidates.length === 0) {
    for (const off of [-1, 1]) {
      const d = new Date(game.startTime);
      d.setUTCDate(d.getUTCDate() + off);
      const dayStr = isoDay(d);
      const near = events.filter(
        (e) =>
          isoDay(new Date(e.commence_time)) === dayStr &&
          namesLooseMatch(e.home_team, game.homeTeam) &&
          namesLooseMatch(e.away_team, game.awayTeam)
      );
      if (near.length) {
        candidates = near;
        break;
      }
    }
  }

  const ids = candidates.map((c) => c.id);
  const usedGames = ids.length
    ? await prisma.game.findMany({ where: { externalEventId: { in: ids } }, select: { id: true, externalEventId: true } })
    : [];
  const usedStaged = ids.length
    ? await prisma.stagedGame.findMany({ where: { oddsApiEventId: { in: ids } }, select: { id: true, oddsApiEventId: true, gameId: true } })
    : [];
  const usedByGame = new Map(usedGames.map((g) => [g.externalEventId as string, g.id]));
  const usedByStaged = new Map(usedStaged.map((s) => [s.oddsApiEventId, s]));

  return {
    found: candidates.length > 0,
    reason: candidates.length === 0 ? 'not_in_current_feed' : undefined,
    searched: { choice, day, homeTeam: game.homeTeam, awayTeam: game.awayTeam },
    candidates: candidates.map((e) => ({
      id: e.id,
      sport_key: e.sport_key,
      commence_time: e.commence_time,
      home_team: e.home_team,
      away_team: e.away_team,
      usedByGameId: usedByGame.get(e.id) ?? null,
      usedByStagedId: usedByStaged.get(e.id)?.id ?? null,
    })),
  };
};

const fdDetailOrThrow = async (matchId: number): Promise<FdMatch> => {
  const res = await fetch(getFootballDataMatchDetailUrl(matchId), footballDataFetchOptions());
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, `football-data match ${matchId} fetch failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const match = (await res.json()) as FdMatch;
  if (!match || typeof match.id !== 'number') throw new ApiError(502, 'Invalid football-data match payload');
  return match;
};

/** Connect (or re-connect) a game to a football-data match id. Admin-confirmed. */
export const linkFootballDataForGame = async (gameId: string, matchId: number, adminId?: string) => {
  if (typeof matchId !== 'number' || !Number.isFinite(matchId) || matchId <= 0) throw new ApiError(400, 'matchId (positive number) is required');
  const game = await loadGame(gameId);
  const match = await fdDetailOrThrow(matchId);

  // Conflict: the GameScore table enforces footballDataMatchId uniqueness
  const scoreOwner = await prisma.gameScore.findUnique({ where: { footballDataMatchId: matchId }, select: { gameId: true } });
  if (scoreOwner && scoreOwner.gameId !== gameId) {
    throw new ApiError(409, `football-data match ${matchId} already has a score row for another game (${scoreOwner.gameId})`);
  }
  // Conflict: another Game may already carry this id in specifications
  const others = await prisma.game.findMany({ where: { id: { not: gameId } }, select: { id: true, specifications: true } });
  const specOwner = others.find((g) => {
    const s = (g.specifications ?? {}) as Record<string, unknown>;
    return s.footballDataMatchId === matchId;
  });
  if (specOwner) throw new ApiError(409, `football-data match ${matchId} is already linked to game ${specOwner.id}`);

  const warnings: string[] = [];
  if (match.utcDate && isoDay(new Date(match.utcDate)) !== isoDay(new Date(game.startTime))) {
    warnings.push(`Kickoff date differs (football-data ${isoDay(new Date(match.utcDate))} vs game ${isoDay(new Date(game.startTime))})`);
  }
  const [homeTeam, awayTeam] = await Promise.all([
    resolveTeam(game.homeTeamId, game.homeTeam),
    resolveTeam(game.awayTeamId, game.awayTeam),
  ]);
  if (!fdTeamMatch(match, homeTeam, game.homeTeam, 'home')) warnings.push(`home team differs (${match.homeTeam?.name ?? '?'} vs ${game.homeTeam})`);
  if (!fdTeamMatch(match, awayTeam, game.awayTeam, 'away')) warnings.push(`away team differs (${match.awayTeam?.name ?? '?'} vs ${game.awayTeam})`);

  const spec = { ...((game.specifications ?? {}) as Record<string, unknown>) };
  spec.footballDataMatchId = match.id;
  if (match.utcDate) spec.footballDataStartTime = new Date(match.utcDate).toISOString();
  const mappedStatus = mapFootballDataStatus(match.status);
  if (mappedStatus) spec.footballDataStatus = mappedStatus;
  await prisma.game.update({ where: { id: gameId }, data: { specifications: spec as never } });

  // Mirror to the linked staged game (keeps cron + staged page consistent)
  if (game.stagedGame && game.stagedGame.footballDataMatchId == null) {
    await prisma.stagedGame
      .update({
        where: { id: game.stagedGame.id },
        data: {
          footballDataMatchId: match.id,
          footballDataStartTime: match.utcDate ? new Date(match.utcDate) : null,
          footballDataRaw: match as unknown as Prisma.InputJsonValue,
          footballDataStatus: mappedStatus,
        },
      })
      .catch(() => undefined);
  }

  if (adminId) {
    await prisma.adminActionLog.create({
      data: {
        userId: adminId,
        action: 'GAME_LINKED_FOOTBALL_DATA',
        targetType: 'Game',
        targetId: gameId,
        metadata: { footballDataMatchId: match.id, warnings } as never,
      },
    });
  }
  return { links: await getGameApiLinks(gameId), match: summarizeMatch(match), warnings };
};

export const unlinkFootballDataForGame = async (gameId: string, adminId?: string) => {
  const game = await loadGame(gameId);
  const spec = { ...((game.specifications ?? {}) as Record<string, unknown>) };
  delete spec.footballDataMatchId;
  delete spec.footballDataStartTime;
  delete spec.footballDataStatus;
  await prisma.game.update({ where: { id: gameId }, data: { specifications: spec as never } });
  if (game.stagedGame) {
    await prisma.stagedGame
      .update({ where: { id: game.stagedGame.id }, data: { gameId: null, status: 'PENDING' } })
      .catch(() => undefined);
  }
  if (adminId) {
    await prisma.adminActionLog.create({
      data: { userId: adminId, action: 'GAME_UNLINKED_FOOTBALL_DATA', targetType: 'Game', targetId: gameId, metadata: {} as never },
    });
  }
  return getGameApiLinks(gameId);
};

/** Set (or clear) the odds-api event id. Empty eventId clears the link. */
export const linkOddsEventForGame = async (gameId: string, eventId: string, adminId?: string) => {
  const game = await loadGame(gameId);
  const trimmed = String(eventId ?? '').trim();

  if (trimmed === '') {
    if (!game.externalEventId) throw new ApiError(400, 'This game has no odds-api event id to remove');
    await prisma.game.update({ where: { id: gameId }, data: { externalEventId: null } });
    if (adminId) {
      await prisma.adminActionLog.create({
        data: { userId: adminId, action: 'GAME_UNLINKED_ODDS_API', targetType: 'Game', targetId: gameId, metadata: { previousEventId: game.externalEventId } as never },
      });
    }
    return { links: await getGameApiLinks(gameId), event: null, warnings: [] as string[] };
  }

  if (trimmed === game.externalEventId) {
    return { links: await getGameApiLinks(gameId), event: null, warnings: ['already linked to this event'] };
  }

  const taken = await prisma.game.findUnique({ where: { externalEventId: trimmed }, select: { id: true } });
  if (taken) throw new ApiError(409, `Odds API event ${trimmed} is already used by game ${taken.id}`);

  // Look it up in both feeds for validation + sport key
  const warnings: string[] = [];
  let found: { sport_key: string; commence_time: string; home_team: string; away_team: string } | null = null;
  let inFeedChoice: SportChoice = choiceForCompetitionName(game.competition?.name);
  const choices: SportChoice[] = ['premier-league', 'champions-league'];
  for (const c of choices) {
    try {
      const events = await fetchEvents(c, false);
      const ev = events.find((e) => e.id === trimmed);
      if (ev) {
        found = ev;
        inFeedChoice = c;
        break;
      }
    } catch {
      // feed unavailable — skip, treat as manual id
    }
  }
  if (!found) {
    warnings.push('event id was not found in the current odds-api feed (it may have started/finished) — set as typed');
  } else {
    if (choiceForCompetitionName(game.competition?.name) !== inFeedChoice) warnings.push(`feed competition differs from game competition (${inFeedChoice})`);
    if (!namesLooseMatch(found.home_team, game.homeTeam)) warnings.push(`home team differs (${found.home_team} vs ${game.homeTeam})`);
    if (!namesLooseMatch(found.away_team, game.awayTeam)) warnings.push(`away team differs (${found.away_team} vs ${game.awayTeam})`);
    if (isoDay(new Date(found.commence_time)) !== isoDay(new Date(game.startTime))) warnings.push(`start date differs (${isoDay(new Date(found.commence_time))} vs ${isoDay(new Date(game.startTime))})`);
  }

  const spec = { ...((game.specifications ?? {}) as Record<string, unknown>) };
  if (found) {
    spec.sport_key = found.sport_key;
    spec.oddsApiEventId = trimmed;
    spec.oddsApiStartTime = new Date(found.commence_time).toISOString();
    await prisma.game.update({ where: { id: gameId }, data: { externalEventId: trimmed, specifications: spec as never } });
  } else {
    await prisma.game.update({ where: { id: gameId }, data: { externalEventId: trimmed } });
  }

  if (adminId) {
    await prisma.adminActionLog.create({
      data: {
        userId: adminId,
        action: 'GAME_LINKED_ODDS_API',
        targetType: 'Game',
        targetId: gameId,
        metadata: { externalEventId: trimmed, warnings } as never,
      },
    });
  }
  return { links: await getGameApiLinks(gameId), event: found ?? { id: trimmed }, warnings };
};
