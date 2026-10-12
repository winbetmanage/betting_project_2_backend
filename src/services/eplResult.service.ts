import fs from 'fs';
import path from 'path';
import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import {
  getEplMatchesUrl,
  getLaLigaMatchesUrl,
  getBundesligaMatchesUrl,
  getSerieAMatchesUrl,
  getLigue1MatchesUrl,
  getChampionsLeagueMatchesUrl,
  footballDataFetchOptions,
} from '../../codes';

type FdMatch = {
  id: number;
  utcDate: string;
  status: string;
  matchday?: number;
  homeTeam: { id: number; name: string; shortName?: string; tla?: string };
  awayTeam: { id: number; name: string; shortName?: string; tla?: string };
  score: {
    winner?: string;
    fullTime: { home: number; away: number };
    halfTime: { home: number; away: number };
  };
};

function normalizeTeam(name: string | undefined | null): string {
  if (!name) return "";
  return name
    .replace(/ FC$/i, "")
    .replace(/ AFC$/i, "")
    .replace(/ United$/i, "")
    .replace(/ Town$/i, "")
    .trim()
    .toLowerCase();
}

async function ensureEplCompetition() {
  return ensureLeagueCompetition('PL');
}

export const RESULT_LEAGUES = {
  PL: { matchesUrl: getEplMatchesUrl, matchNames: ['Premier', 'EPL'], name: 'English Premier League', country: 'England', label: 'English Premier League' },
  PD: { matchesUrl: getLaLigaMatchesUrl, matchNames: ['La Liga'], name: 'Spain La Liga', country: 'Spain', label: 'Spain LaLiga' },
  BL1: { matchesUrl: getBundesligaMatchesUrl, matchNames: ['Bundesliga'], name: 'Germany Bundesliga', country: 'Germany', label: 'Bundesliga' },
  SA: { matchesUrl: getSerieAMatchesUrl, matchNames: ['Serie A'], name: 'Italy Serie A', country: 'Italy', label: 'Serie A' },
  FL1: { matchesUrl: getLigue1MatchesUrl, matchNames: ['Ligue 1'], name: 'France Ligue 1', country: 'France', label: 'Ligue 1' },
  CL: { matchesUrl: getChampionsLeagueMatchesUrl, matchNames: ['Champions'], name: 'UEFA Champions League', country: 'Europe', label: 'Champions League' },
} as const;

export type ResultLeagueCode = keyof typeof RESULT_LEAGUES;

export const isResultLeagueCode = (v: unknown): v is ResultLeagueCode =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(RESULT_LEAGUES, v);

async function ensureLeagueCompetition(code: ResultLeagueCode) {
  const cfg = RESULT_LEAGUES[code];
  let sport = await prisma.sport.findFirst({ where: { slug: 'soccer' } });
  if (!sport) sport = await prisma.sport.findFirst({ where: { gameType: 'SOCCER' } });
  if (!sport) sport = await prisma.sport.create({ data: { name: 'Soccer', slug: 'soccer', gameType: 'SOCCER' } });

  for (const m of cfg.matchNames) {
    const competition = await prisma.competition.findFirst({ where: { sportId: sport.id, name: { contains: m } } });
    if (competition) return competition;
  }
  return prisma.competition.create({ data: { name: cfg.name, country: cfg.country, sportId: sport.id } });
}

async function findOrCreateGame(m: FdMatch, competitionId: string) {
  const homeShort = m.homeTeam.shortName || m.homeTeam.name;
  const awayShort = m.awayTeam.shortName || m.awayTeam.name;
  const homeNorm = normalizeTeam(homeShort);
  const awayNorm = normalizeTeam(awayShort);

  // Try to find an existing game by normalized team names (scoped to this league)
  const existing = await prisma.game.findFirst({
    where: {
      competitionId,
      homeTeam: { contains: homeShort },
      awayTeam: { contains: awayShort },
    },
  });
  if (existing) return existing;

  const alt = await prisma.game.findFirst({
    where: {
      competitionId,
      homeTeam: { contains: homeNorm },
      awayTeam: { contains: awayNorm },
    },
  });
  if (alt) return alt;

  // No match -> create a new Game so GameScore can link to it
  return prisma.game.create({
    data: {
      competitionId,
      homeTeam: homeShort,
      awayTeam: awayShort,
      startTime: new Date(m.utcDate),
      status: m.status === 'FINISHED' ? 'FINISHED' : m.status === 'TIMED' ? 'SCHEDULED' : m.status === 'LIVE' ? 'LIVE' : m.status === 'SCHEDULED' ? 'SCHEDULED' : 'SCHEDULED',
      isPublished: false,
      specifications: { footballDataMatchId: m.id } as never,
    },
  });
}

function scoresDir(): string {
  const dirs = [
    path.join(process.cwd(), 'epl_games_scores'),
    path.join(process.cwd(), 'Back-end', 'epl_games_scores'),
  ];
  for (const d of dirs) if (fs.existsSync(d)) return d;
  const primary = path.join(process.cwd(), 'epl_games_scores');
  fs.mkdirSync(primary, { recursive: true });
  return primary;
}

export async function fetchEplMatchesAndUpsert() {
  return fetchLeagueMatchesAndUpsert('PL');
}

export async function fetchLeagueMatchesAndUpsert(code: ResultLeagueCode) {
  const cfg = RESULT_LEAGUES[code];
  const url = cfg.matchesUrl();
  const res = await fetch(url, footballDataFetchOptions());
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, `Football-Data fetch failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { matches?: FdMatch[]; resultSet?: { count?: number; played?: number } };
  const matches = data.matches ?? [];
  if (!Array.isArray(matches)) throw new ApiError(500, 'Invalid Football-Data response');

  const competition = await ensureLeagueCompetition(code);
  const dir = scoresDir();

  let added = 0;
  let updated = 0;

  for (const m of matches) {
    const game = await findOrCreateGame(m, competition.id);
    const ft = m.score?.fullTime ?? { home: 0, away: 0 };
    const ht = m.score?.halfTime ?? { home: 0, away: 0 };

    const existingScore = await prisma.gameScore.findUnique({ where: { footballDataMatchId: m.id } });

    await prisma.gameScore.upsert({
      where: { footballDataMatchId: m.id },
      create: {
        gameId: game.id,
        footballDataMatchId: m.id,
        homeScoreHT: ht.home ?? 0,
        awayScoreHT: ht.away ?? 0,
        homeScoreFT: ft.home ?? 0,
        awayScoreFT: ft.away ?? 0,
        winner: m.score?.winner ?? null,
        status: m.status ?? 'UNKNOWN',
        rawJson: m as never,
      },
      update: {
        gameId: game.id,
        homeScoreHT: ht.home ?? 0,
        awayScoreHT: ht.away ?? 0,
        homeScoreFT: ft.home ?? 0,
        awayScoreFT: ft.away ?? 0,
        winner: m.score?.winner ?? null,
        status: m.status ?? 'UNKNOWN',
        fetchedAt: new Date(),
        rawJson: m as never,
      },
    });

    if (existingScore) updated++;
    else added++;

    // Save raw JSON snapshot (audit)
    try {
      fs.writeFileSync(path.join(dir, `${m.id}.json`), JSON.stringify(m, null, 2), 'utf-8');
    } catch {}
  }

  return { added, updated, total: matches.length, resultCount: data.resultSet?.count ?? matches.length, played: data.resultSet?.played ?? 0 };
}

export async function listEplScores() {
  return listLeagueScores('PL');
}

export async function listLeagueScores(code: ResultLeagueCode) {
  const competition = await ensureLeagueCompetition(code);
  return prisma.gameScore.findMany({
    where: { game: { competitionId: competition.id } },
    include: { game: { include: { competition: true } } },
    orderBy: { game: { startTime: 'asc' } },
  });
}
