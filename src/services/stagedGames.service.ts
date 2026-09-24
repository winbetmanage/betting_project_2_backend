import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import { Prisma, FootballDataMatchStatus } from '@prisma/client';
import { getEplEventsUrl, getChampionsLeagueEventsUrl, getEplMatchesUrl, getChampionsLeagueMatchesUrl, getFootballDataMatchDetailUrl, footballDataFetchOptions } from '../../codes';

export type FdTeam = { id: number; name: string; shortName?: string; tla?: string };
export type FdMatch = {
  id: number;
  utcDate: string;
  status: string;
  matchday?: number;
  season?: { id?: number; name?: string; startDate?: string; endDate?: string };
  competition?: { id?: number; name?: string; code?: string };
  homeTeam: FdTeam;
  awayTeam: FdTeam;
  score?: { winner?: string; fullTime?: { home: number | null; away: number | null }; halfTime?: { home: number | null; away: number | null } };
};

const TEAM_SELECT_FULL = {
  id: true, fullName: true, shortName: true, iconUrl: true,
  oddsApiName: true, footballDataName: true, footballDataTeamId: true, country: true,
} as const;

export const SPORTS = {
  'premier-league': {
    label: 'Premier League',
    sportKey: 'soccer_epl',
    url: () => getEplEventsUrl(),
    competition: { name: 'English Premier League', country: 'England', matchName: 'Premier' },
  },
  'champions-league': {
    label: 'UEFA Champions League',
    sportKey: 'soccer_uefa_champs_league',
    url: () => getChampionsLeagueEventsUrl(),
    competition: { name: 'UEFA Champions League', country: 'Europe', matchName: 'Champions' },
  },
} as const;

export type SportChoice = keyof typeof SPORTS;

export const isSportChoice = (v: unknown): v is SportChoice =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(SPORTS, v);

export type OddsEvent = {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
};

const eventCache = new Map<SportChoice, { data: OddsEvent[]; at: number }>();
const CACHE_TTL = 5 * 60 * 1000;

export async function fetchEvents(choice: SportChoice, force: boolean): Promise<OddsEvent[]> {
  if (!force) {
    const cached = eventCache.get(choice);
    if (cached && Date.now() - cached.at < CACHE_TTL) return cached.data;
  }
  const url = SPORTS[choice].url();
  if (!url.includes('apiKey=') || url.includes('apiKey=undefined')) {
    throw new ApiError(500, 'API key not configured (API_ONE)');
  }
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, `Failed to fetch ${SPORTS[choice].label} events: ${res.status} ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as OddsEvent[];
  if (!Array.isArray(data)) throw new ApiError(500, 'Invalid data from The Odds API');
  eventCache.set(choice, { data, at: Date.now() });
  return data;
}

export const listSportEvents = async (choice: SportChoice, filters: Record<string, unknown> = {}) => {
  const all = await fetchEvents(choice, !!filters.force);
  // Already-staged events never show here — staging happens by selecting from this list
  const stagedIds = await getStagedEventIds();
  const unstaged = all.filter((e) => !stagedIds.has(e.id));
  const search = typeof filters.search === 'string' ? filters.search.trim().toLowerCase() : '';
  const filtered = search
    ? unstaged.filter((e) =>
        [e.id, e.sport_key, e.sport_title, e.home_team, e.away_team, e.commence_time].some((f) =>
          String(f).toLowerCase().includes(search)
        )
      )
    : unstaged;

  const page = Math.max(1, parseInt(String(filters.page ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(filters.limit ?? '20'), 10) || 20));
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * limit;
  return { data: filtered.slice(start, start + limit), total, page: currentPage, limit, totalPages };
};

async function ensureCompetition(choice: SportChoice) {
  const cfg = SPORTS[choice];
  let sport = await prisma.sport.findFirst({ where: { slug: 'soccer' } });
  if (!sport) sport = await prisma.sport.findFirst({ where: { gameType: 'SOCCER' } });
  if (!sport) sport = await prisma.sport.create({ data: { name: 'Soccer', slug: 'soccer', gameType: 'SOCCER' } });
  let competition = await prisma.competition.findFirst({ where: { sportId: sport.id, name: { contains: cfg.competition.matchName } } });
  if (!competition) {
    competition = await prisma.competition.create({ data: { name: cfg.competition.name, country: cfg.competition.country, sportId: sport.id } });
  }
  return competition;
}

async function resolveTeamIds(names: string[]): Promise<{ ids: Map<string, string>; created: string[] }> {
  const unique = Array.from(new Set(names.filter((n) => typeof n === 'string' && n.trim() !== '')));
  const existing = await prisma.team.findMany({ where: { oddsApiName: { in: unique } }, select: { id: true, oddsApiName: true } });
  const ids = new Map<string, string>();
  for (const t of existing) if (t.oddsApiName) ids.set(t.oddsApiName, t.id);
  const created: string[] = [];
  for (const name of unique) {
    if (ids.has(name)) continue;
    const row = await prisma.team.upsert({ where: { oddsApiName: name }, update: {}, create: { fullName: name, oddsApiName: name } });
    ids.set(name, row.id);
    created.push(name);
  }
  return { ids, created };
}

export const getStagedEventIds = async (): Promise<Set<string>> => {
  const rows = await prisma.stagedGame.findMany({ select: { oddsApiEventId: true } });
  return new Set(rows.map((r) => r.oddsApiEventId));
};

/**
 * Delete all staged games whose football-data status is FINISHED.
 * Rows already promoted into the Games table (gameId set) are NEVER deleted.
 */
export const clearFinishedStagedGames = async (adminId?: string) => {
  const rows = await prisma.stagedGame.findMany({
    where: { footballDataStatus: 'FINISHED', gameId: null },
    select: { id: true },
  });
  let deleted = 0;
  if (rows.length > 0) {
    const res = await prisma.stagedGame.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    deleted = res.count;
    if (adminId && deleted > 0) {
      await prisma.adminActionLog.create({
        data: {
          userId: adminId,
          action: 'STAGED_GAMES_CLEAR_FINISHED',
          targetType: 'StagedGame',
          metadata: { deleted } as unknown as Prisma.InputJsonValue,
        },
      });
    }
  }
  return { deleted };
};

/**
 * Bulk-delete staged games. Rows already promoted into the Games table
 * (gameId set) are NEVER deleted — they are skipped and reported.
 */
export const deleteStagedGames = async (ids: unknown, adminId?: string) => {
  if (!Array.isArray(ids) || ids.length === 0) throw new ApiError(400, 'No staged games selected');
  const idList = Array.from(new Set(ids.filter((v): v is string => typeof v === 'string' && v.trim() !== '')));
  if (idList.length === 0) throw new ApiError(400, 'No valid staged game ids provided');

  const rows = await prisma.stagedGame.findMany({ where: { id: { in: idList } }, select: { id: true, gameId: true } });
  if (rows.length === 0) throw new ApiError(404, 'No matching staged games found');

  const deletable = rows.filter((r) => r.gameId == null).map((r) => r.id);
  const skipped = rows.length - deletable.length;

  let deleted = 0;
  if (deletable.length > 0) {
    const res = await prisma.stagedGame.deleteMany({ where: { id: { in: deletable } } });
    deleted = res.count;
    if (adminId && deleted > 0) {
      await prisma.adminActionLog.create({
        data: {
          userId: adminId,
          action: 'STAGED_GAMES_DELETED',
          targetType: 'StagedGame',
          metadata: { deleted, skipped, ids: deletable } as unknown as Prisma.InputJsonValue,
        },
      });
    }
  }
  return { deleted, skipped };
};

export type StageSummary = {
  choice: SportChoice;
  fetched: number;
  alreadyStaged: number;
  added: number;
  createdTeams: string[];
  unresolved: { fixture: string; reason: string }[];
};

export const stageFromOdds = async (choice: SportChoice, adminId?: string): Promise<StageSummary> => {
  const events = await fetchEvents(choice, true);
  const existingSet = await getStagedEventIds();
  const newEvents = events.filter((e) => !existingSet.has(e.id));
  const alreadyStaged = events.length - newEvents.length;

  const summary: StageSummary = { choice, fetched: events.length, alreadyStaged, added: 0, createdTeams: [], unresolved: [] };
  if (newEvents.length === 0) return summary;

  const competition = await ensureCompetition(choice);
  const { ids: teamIds, created } = await resolveTeamIds(newEvents.flatMap((e) => [e.home_team, e.away_team]));
  summary.createdTeams = created;

  const rows: Prisma.StagedGameCreateManyInput[] = [];
  for (const e of newEvents) {
    const homeId = teamIds.get(e.home_team);
    const awayId = teamIds.get(e.away_team);
    if (!homeId || !awayId || homeId === awayId) {
      summary.unresolved.push({ fixture: `${e.home_team} vs ${e.away_team}`, reason: 'team could not be resolved' });
      continue;
    }
    rows.push({
      oddsApiEventId: e.id,
      oddsApiStartTime: new Date(e.commence_time),
      oddsApiRaw: e as unknown as Prisma.InputJsonValue,
      homeTeamId: homeId,
      awayTeamId: awayId,
      competitionId: competition.id,
      status: 'PENDING',
      stagedById: adminId ?? null,
    });
  }

  if (rows.length > 0) {
    const result = await prisma.stagedGame.createMany({ data: rows, skipDuplicates: true });
    summary.added = result.count;
  }
  return summary;
};

/**
 * Stage only the explicitly selected odds events (from the PL / CL fetch pages).
 * Unknown ids and already-staged events are reported, never duplicated.
 */
export const stageSelectedEvents = async (choice: SportChoice, eventIds: unknown, adminId?: string): Promise<StageSummary> => {
  const ids = Array.from(
    new Set(Array.isArray(eventIds) ? eventIds.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [])
  );
  if (ids.length === 0) throw new ApiError(400, 'No events selected');

  const events = await fetchEvents(choice, true);
  const byId = new Map(events.map((e) => [e.id, e]));
  const existingSet = await getStagedEventIds();

  const summary: StageSummary = { choice, fetched: events.length, alreadyStaged: 0, added: 0, createdTeams: [], unresolved: [] };
  const targets: OddsEvent[] = [];
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) {
      summary.unresolved.push({ fixture: id, reason: 'event not in the current feed' });
      continue;
    }
    if (existingSet.has(id)) {
      summary.alreadyStaged += 1;
      continue;
    }
    targets.push(e);
  }
  if (targets.length === 0) return summary;

  const competition = await ensureCompetition(choice);
  const { ids: teamIds, created } = await resolveTeamIds(targets.flatMap((e) => [e.home_team, e.away_team]));
  summary.createdTeams = created;

  const rows: Prisma.StagedGameCreateManyInput[] = [];
  for (const e of targets) {
    const homeId = teamIds.get(e.home_team);
    const awayId = teamIds.get(e.away_team);
    if (!homeId || !awayId || homeId === awayId) {
      summary.unresolved.push({ fixture: `${e.home_team} vs ${e.away_team}`, reason: 'team could not be resolved' });
      continue;
    }
    rows.push({
      oddsApiEventId: e.id,
      oddsApiStartTime: new Date(e.commence_time),
      oddsApiRaw: e as unknown as Prisma.InputJsonValue,
      homeTeamId: homeId,
      awayTeamId: awayId,
      competitionId: competition.id,
      status: 'PENDING',
      stagedById: adminId ?? null,
    });
  }

  if (rows.length > 0) {
    const result = await prisma.stagedGame.createMany({ data: rows, skipDuplicates: true });
    summary.added = result.count;
  }
  return summary;
};

export type RefreshStagedSummary = {
  checked: number;
  oddsUpdated: number;
  fdUpdated: number;
  errors: { id: string; message: string }[];
};

/**
 * Refresh staged rows from the APIs: odds kickoff/raw from the free events feeds,
 * football-data status/start/raw for linked matches. Never creates or deletes rows.
 */
export const refreshStagedGames = async (): Promise<RefreshStagedSummary> => {
  const summary: RefreshStagedSummary = { checked: 0, oddsUpdated: 0, fdUpdated: 0, errors: [] };
  const [epl, cl] = await Promise.all([fetchEvents('premier-league', true), fetchEvents('champions-league', true)]);
  const feed = new Map<string, OddsEvent>([...epl, ...cl].map((e) => [e.id, e]));

  const rows = await prisma.stagedGame.findMany({
    select: { id: true, oddsApiEventId: true, oddsApiStartTime: true, footballDataMatchId: true },
  });
  for (const row of rows) {
    summary.checked += 1;
    try {
      const data: Prisma.StagedGameUpdateInput = {};
      const ev = feed.get(row.oddsApiEventId);
      if (ev) {
        const fresh = new Date(ev.commence_time);
        if (fresh.getTime() !== new Date(row.oddsApiStartTime).getTime()) {
          data.oddsApiStartTime = fresh;
          summary.oddsUpdated += 1;
        }
        data.oddsApiRaw = ev as unknown as Prisma.InputJsonValue;
      }
      if (row.footballDataMatchId != null) {
        const res = await fetch(getFootballDataMatchDetailUrl(row.footballDataMatchId), footballDataFetchOptions());
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new ApiError(res.status, `Football-Data refresh failed: ${res.status} ${text.slice(0, 120)}`);
        }
        const match = (await res.json()) as FdMatch;
        if (!match || typeof match.id !== 'number') throw new ApiError(502, 'Invalid Football-Data match payload');
        data.footballDataStartTime = match.utcDate ? new Date(match.utcDate) : null;
        data.footballDataRaw = match as unknown as Prisma.InputJsonValue;
        data.footballDataStatus = mapFootballDataStatus(match.status);
        summary.fdUpdated += 1;
      }
      if (Object.keys(data).length > 0) {
        await prisma.stagedGame.update({ where: { id: row.id }, data });
      }
    } catch (e) {
      summary.errors.push({ id: row.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return summary;
};

export const listStagedGames = async (filters: Record<string, unknown> = {}) => {
  const where: Prisma.StagedGameWhereInput = {};
  const status = typeof filters.status === 'string' ? filters.status.trim() : '';
  if (status && status !== 'ALL') where.status = status as never;

  const competition = typeof filters.competition === 'string' ? filters.competition.trim() : '';
  if (competition && isSportChoice(competition)) {
    where.competition = { name: { contains: SPORTS[competition].competition.matchName } };
  }

  const search = typeof filters.search === 'string' ? filters.search.trim() : '';
  if (search) {
    where.OR = [
      { oddsApiEventId: { contains: search } },
      { homeTeam: { fullName: { contains: search } } },
      { awayTeam: { fullName: { contains: search } } },
    ];
  }

  // Visibility rules for the staged queue (pagination-safe id exclusion):
  // 1. finished games never show (footballDataStatus FINISHED)
  // 2. kickoff already passed never shows, even when the game is not finished
  // 3. rescheduled away: linked football-data date no longer on the same UTC day
  //    as the odds kickoff (same UTC-day rule the FD linker enforces)
  // Computed in JS (UTC-correct) over a lightweight full scan — staged tables are small.
  const now = new Date();
  const meta = await prisma.stagedGame.findMany({
    select: { id: true, oddsApiStartTime: true, footballDataStatus: true, footballDataStartTime: true },
  });
  const hidden = { finished: 0, pastKickoff: 0, rescheduled: 0 };
  const hiddenIds: string[] = [];
  for (const r of meta) {
    if (r.footballDataStatus === 'FINISHED') {
      hidden.finished += 1;
      hiddenIds.push(r.id);
    } else if (new Date(r.oddsApiStartTime).getTime() < now.getTime()) {
      hidden.pastKickoff += 1;
      hiddenIds.push(r.id);
    } else if (r.footballDataStartTime && isoDay(new Date(r.oddsApiStartTime)) !== isoDay(new Date(r.footballDataStartTime))) {
      hidden.rescheduled += 1;
      hiddenIds.push(r.id);
    }
  }
  const includeHidden = filters.includeHidden === true || filters.includeHidden === 'true' || filters.includeHidden === '1';
  if (!includeHidden && hiddenIds.length > 0) {
    where.AND = [{ id: { notIn: hiddenIds } }];
  }

  const page = Math.max(1, parseInt(String(filters.page ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(filters.limit ?? '20'), 10) || 20));

  const [total, data] = await prisma.$transaction([
    prisma.stagedGame.count({ where }),
    prisma.stagedGame.findMany({
      where,
      orderBy: { oddsApiStartTime: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        homeTeam: { select: { id: true, fullName: true, shortName: true, iconUrl: true } },
        awayTeam: { select: { id: true, fullName: true, shortName: true, iconUrl: true } },
        competition: { select: { id: true, name: true, country: true } },
        game: { select: { id: true, status: true, isPublished: true } },
      },
    }),
  ]);

  const statusCounts = await prisma.stagedGame.groupBy({ by: ['status'], _count: { _all: true } });
  const counts = { PENDING: 0, MATCH_NOT_FOUND: 0, CONFIRMED: 0, REJECTED: 0 } as Record<string, number>;
  for (const s of statusCounts) counts[s.status] = s._count._all;

  const totalPages = Math.max(1, Math.ceil(total / limit));
  return { data, total, page, limit, totalPages, counts, hidden };
};

export function choiceForCompetitionName(name: string | null | undefined): SportChoice {
  const lower = (name ?? '').toLowerCase();
  if (lower.includes('champions')) return 'champions-league';
  return 'premier-league';
}

export function teamHasFdMapping(team: { footballDataTeamId: number | null; footballDataName: string | null }): boolean {
  return team.footballDataTeamId != null || !!team.footballDataName;
}

export function fdTeamMatchesTeam(fdTeam: FdTeam | undefined, team: { footballDataTeamId: number | null; footballDataName: string | null }): boolean {
  if (!fdTeam) return false;
  if (team.footballDataTeamId != null) return fdTeam.id === team.footballDataTeamId;
  if (team.footballDataName) return fdTeam.name === team.footballDataName;
  return false;
}

export function summarizeMatch(m: FdMatch) {
  return {
    id: m.id,
    utcDate: m.utcDate,
    status: m.status,
    matchday: m.matchday ?? null,
    season: m.season?.name ?? null,
    competition: m.competition?.name ?? null,
    home: m.homeTeam ? { id: m.homeTeam.id, name: m.homeTeam.name, shortName: m.homeTeam.shortName ?? null, tla: m.homeTeam.tla ?? null } : null,
    away: m.awayTeam ? { id: m.awayTeam.id, name: m.awayTeam.name, shortName: m.awayTeam.shortName ?? null, tla: m.awayTeam.tla ?? null } : null,
    score: m.score
      ? {
          fullTimeHome: m.score.fullTime?.home ?? null,
          fullTimeAway: m.score.fullTime?.away ?? null,
          halfTimeHome: m.score.halfTime?.home ?? null,
          halfTimeAway: m.score.halfTime?.away ?? null,
          winner: m.score.winner ?? null,
        }
      : null,
  };
}

export async function loadStagedForFd(id: string) {
  const staged = await prisma.stagedGame.findUnique({
    where: { id },
    include: { homeTeam: { select: TEAM_SELECT_FULL }, awayTeam: { select: TEAM_SELECT_FULL }, competition: { select: { id: true, name: true, country: true } } },
  });
  if (!staged) throw new ApiError(404, 'Staged game not found');
  return staged;
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const FD_EXACT_STATUSES: readonly string[] = ["SCHEDULED", "TIMED", "IN_PLAY", "PAUSED", "FINISHED", "POSTPONED", "SUSPENDED", "CANCELLED", "AWARDED"];
const FD_LIVE_STATUSES: readonly string[] = ["FIRST_HALF", "SECOND_HALF", "EXTRA_TIME", "PENALTY", "REGULAR_TIME"];

export function mapFootballDataStatus(raw: unknown): FootballDataMatchStatus | null {
  if (typeof raw !== "string") return null;
  const u = raw.trim().toUpperCase();
  if (u === "") return null;
  if (FD_EXACT_STATUSES.includes(u)) return u as FootballDataMatchStatus;
  if (u === "HALF_TIME" || u === "BREAK_TIME") return "PAUSED";
  if (FD_LIVE_STATUSES.includes(u)) return "IN_PLAY";
  return null;
}

export async function fetchFdMatchesByDay(choice: SportChoice, dayIso: string): Promise<FdMatch[]> {
  const base = choice === 'champions-league' ? getChampionsLeagueMatchesUrl() : getEplMatchesUrl();
  const url = `${base}?date=${dayIso}`;
  const res = await fetch(url, footballDataFetchOptions());
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, `Football-Data fetch failed (${choice}): ${res.status} ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { matches?: FdMatch[] };
  return Array.isArray(data.matches) ? data.matches : [];
}

export type FdFindResult = {
  found: boolean;
  match?: ReturnType<typeof summarizeMatch>;
  searched: { choice: SportChoice; day: string; homeTeam: string; awayTeam: string; fixturesThatDay: number };
  reason?: string;
  dayFixtures?: ReturnType<typeof summarizeMatch>[];
};

export const findFootballDataMatch = async (id: string): Promise<FdFindResult> => {
  const staged = await loadStagedForFd(id);
  const choice = choiceForCompetitionName(staged.competition.name);
  const day = isoDay(new Date(staged.oddsApiStartTime));

  const searched = {
    choice,
    day,
    homeTeam: staged.homeTeam.fullName,
    awayTeam: staged.awayTeam.fullName,
    fixturesThatDay: 0,
  };

  if (!teamHasFdMapping(staged.homeTeam) || !teamHasFdMapping(staged.awayTeam)) {
    return { found: false, searched, reason: 'teams_not_mapped', dayFixtures: [] };
  }

  // football-data ignores ?date= here, so filter by same UTC day ourselves
  const matches = await fetchFdMatchesByDay(choice, day);
  const sameDay = matches.filter((m) => m.utcDate && isoDay(new Date(m.utcDate)) === day);
  searched.fixturesThatDay = sameDay.length;

  const match = sameDay.find((m) => fdTeamMatchesTeam(m.homeTeam, staged.homeTeam) && fdTeamMatchesTeam(m.awayTeam, staged.awayTeam));
  const dayFixtures = sameDay.map(summarizeMatch);
  if (!match) return { found: false, searched, reason: 'no_fixture_same_day', dayFixtures };
  return { found: true, match: summarizeMatch(match), searched, dayFixtures };
};

export const linkFootballDataMatch = async (id: string, matchId: number) => {
  if (typeof matchId !== 'number' || !Number.isFinite(matchId)) throw new ApiError(400, 'matchId (number) is required');
  const staged = await loadStagedForFd(id);
  if (staged.gameId) throw new ApiError(409, 'This staged game is already added to the games table; its football-data link cannot be changed.');

  const res = await fetch(getFootballDataMatchDetailUrl(matchId), footballDataFetchOptions());
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, `Football-Data match fetch failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const match = (await res.json()) as FdMatch;
  if (!match || typeof match.id !== 'number') throw new ApiError(502, 'Invalid Football-Data match payload');

  const stagedDay = isoDay(new Date(staged.oddsApiStartTime));
  const matchDay = match.utcDate ? isoDay(new Date(match.utcDate)) : '';
  if (matchDay !== stagedDay) {
    throw new ApiError(400, `Fixture date (${matchDay || '?'}) does not match the staged game date (${stagedDay}).`);
  }
  if (!fdTeamMatchesTeam(match.homeTeam, staged.homeTeam) || !fdTeamMatchesTeam(match.awayTeam, staged.awayTeam)) {
    throw new ApiError(400, 'Football-Data fixture teams do not match this staged game.');
  }

  try {
    await prisma.stagedGame.update({
      where: { id },
      data: {
        footballDataMatchId: match.id,
        footballDataStartTime: match.utcDate ? new Date(match.utcDate) : null,
        footballDataRaw: match as unknown as Prisma.InputJsonValue,
        footballDataStatus: mapFootballDataStatus(match.status),
      },
    });
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2002') throw new ApiError(409, 'That football-data match is already linked to another staged game.');
    throw e;
  }
  return getStagedGame(id);
};

export const refreshFootballDataMatch = async (id: string) => {
  const staged = await prisma.stagedGame.findUnique({ where: { id }, select: { id: true, footballDataMatchId: true } });
  if (!staged) throw new ApiError(404, 'Staged game not found');
  if (staged.footballDataMatchId == null) throw new ApiError(400, 'No football-data match is linked yet.');

  const res = await fetch(getFootballDataMatchDetailUrl(staged.footballDataMatchId), footballDataFetchOptions());
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, `Football-Data refresh failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const match = (await res.json()) as FdMatch;
  if (!match || typeof match.id !== 'number') throw new ApiError(502, 'Invalid Football-Data match payload');

  await prisma.stagedGame.update({
    where: { id },
    data: {
      footballDataStartTime: match.utcDate ? new Date(match.utcDate) : null,
      footballDataRaw: match as unknown as Prisma.InputJsonValue,
      footballDataStatus: mapFootballDataStatus(match.status),
    },
  });
  return getStagedGame(id);
};

export const unlinkFootballDataMatch = async (id: string) => {
  const staged = await loadStagedForFd(id);
  if (staged.gameId) throw new ApiError(400, 'Cannot remove the football-data link: this staged game is already added to the games table.');
  if (staged.footballDataMatchId == null) throw new ApiError(400, 'No football-data match is linked.');
  await prisma.stagedGame.update({
    where: { id },
    data: { footballDataMatchId: null, footballDataStartTime: null, footballDataRaw: Prisma.DbNull, footballDataStatus: null },
  });
  return getStagedGame(id);
};

export const confirmStagedGameToGames = async (id: string, adminId?: string) => {
  const staged = await prisma.stagedGame.findUnique({
    where: { id },
    include: { homeTeam: { select: { id: true, fullName: true } }, awayTeam: { select: { id: true, fullName: true } } },
  });
  if (!staged) throw new ApiError(404, 'Staged game not found');
  if (staged.gameId) throw new ApiError(409, 'This staged game is already added to the games table.');
  if (staged.status === 'REJECTED') throw new ApiError(400, 'A rejected staged game cannot be added to the games table.');
  if (staged.footballDataMatchId == null) throw new ApiError(400, 'Link a football-data match before adding this game to the games table.');

  const raw = staged.oddsApiRaw as { sport_key?: unknown } | null;
  const sportKey = typeof raw?.sport_key === 'string' ? raw.sport_key : null;
  const startTime = staged.footballDataStartTime ?? staged.oddsApiStartTime;

  // Prevent duplicate football-data match id (GameScore.footballDataMatchId is @unique).
  // Seeded games may already own this match id — confirming a duplicate would break
  // settlement (Duplicate entry on GameScore).
  const existingByFd = await prisma.gameScore.findUnique({ where: { footballDataMatchId: staged.footballDataMatchId } });
  if (existingByFd) throw new ApiError(409, `A game for football-data match ${staged.footballDataMatchId} already exists (game ${existingByFd.gameId}). Delete or archive the old game first.`);

  try {
    await prisma.$transaction(async (tx) => {
      const game = await tx.game.create({
        data: {
          competitionId: staged.competitionId,
          externalEventId: staged.oddsApiEventId,
          homeTeam: staged.homeTeam.fullName,
          awayTeam: staged.awayTeam.fullName,
          homeTeamId: staged.homeTeam.id,
          awayTeamId: staged.awayTeam.id,
          startTime,
          status: 'SCHEDULED',
          isPublished: false,
          specifications: {
            source: 'staged',
            stagedGameId: staged.id,
            sport_key: sportKey,
            footballDataMatchId: staged.footballDataMatchId,
            oddsApiEventId: staged.oddsApiEventId,
            oddsApiStartTime: staged.oddsApiStartTime.toISOString(),
            footballDataStartTime: staged.footballDataStartTime ? staged.footballDataStartTime.toISOString() : null,
            footballDataStatus: staged.footballDataStatus,
          } as never,
        },
      });
      await tx.stagedGame.update({
        where: { id },
        data: { gameId: game.id, status: 'CONFIRMED', reviewedById: adminId ?? null, reviewedAt: new Date() },
      });
      if (adminId) {
        await tx.adminActionLog.create({
          data: {
            userId: adminId,
            action: 'STAGED_GAME_CONFIRMED',
            targetType: 'Game',
            targetId: game.id,
            metadata: { stagedGameId: staged.id, externalEventId: staged.oddsApiEventId, footballDataMatchId: staged.footballDataMatchId } as never,
          },
        });
      }
    });
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2002') throw new ApiError(409, 'A game for this odds-api event already exists in the games table.');
    throw e;
  }

  return getStagedGame(id);
};

export const getStagedGame = async (id: string) => {
  const staged = await prisma.stagedGame.findUnique({
    where: { id },
    include: {
      homeTeam: { select: TEAM_SELECT_FULL },
      awayTeam: { select: TEAM_SELECT_FULL },
      competition: { select: { id: true, name: true, country: true } },
      game: { select: { id: true, status: true, isPublished: true, homeTeam: true, awayTeam: true, startTime: true } },
      reviewedBy: { select: { id: true, name: true, email: true } },
      stagedBy: { select: { id: true, name: true, email: true } },
    },
  });
  if (!staged) throw new ApiError(404, 'Staged game not found');
  return staged;
};

