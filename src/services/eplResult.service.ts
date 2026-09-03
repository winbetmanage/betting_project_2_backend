import fs from 'fs';
import path from 'path';
import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import { getEplAllMatchesUrl, footballDataFetchOptions } from '../../codes';

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
  let sport = await prisma.sport.findFirst({ where: { slug: 'soccer' } });
  if (!sport) sport = await prisma.sport.findFirst({ where: { gameType: 'SOCCER' } });
  if (!sport) sport = await prisma.sport.create({ data: { name: 'Soccer', slug: 'soccer', gameType: 'SOCCER' } });

  let competition = await prisma.competition.findFirst({ where: { sportId: sport.id, name: { contains: 'Premier' } } });
  if (!competition) competition = await prisma.competition.findFirst({ where: { sportId: sport.id, name: 'EPL' } });
  if (!competition) competition = await prisma.competition.create({ data: { name: 'English Premier League', country: 'England', sportId: sport.id } });
  return competition;
}

async function findOrCreateGame(m: FdMatch, competitionId: string) {
  const homeShort = m.homeTeam.shortName || m.homeTeam.name;
  const awayShort = m.awayTeam.shortName || m.awayTeam.name;
  const homeNorm = normalizeTeam(homeShort);
  const awayNorm = normalizeTeam(awayShort);

  // Try to find an existing game by normalized team names
  const existing = await prisma.game.findFirst({
    where: {
      homeTeam: { contains: homeShort },
      awayTeam: { contains: awayShort },
    },
  });
  if (existing) return existing;

  const alt = await prisma.game.findFirst({
    where: {
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
  const url = getEplAllMatchesUrl();
  const res = await fetch(url, footballDataFetchOptions());
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, `Football-Data fetch failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { matches?: FdMatch[]; resultSet?: { count?: number; played?: number } };
  const matches = data.matches ?? [];
  if (!Array.isArray(matches)) throw new ApiError(500, 'Invalid Football-Data response');

  const competition = await ensureEplCompetition();
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
        rawJsonPath: `epl_games_scores/${m.id}.json`,
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
  return prisma.gameScore.findMany({
    include: { game: true },
    orderBy: { game: { startTime: 'asc' } },
  });
}
