import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import { getEplEventsUrl } from '../../codes';
import * as eplGameOdds from './eplGameOdds.service';

type EplEvent = {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
};

let cache: { data: EplEvent[]; fetchedAt: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export const fetchEplEvents = async (force = false): Promise<EplEvent[]> => {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL) {
    return cache.data;
  }
  const url = getEplEventsUrl();
  if (!url.includes('apiKey=') || url.includes('apiKey=undefined')) {
    throw new ApiError(500, 'API key not configured (API_ONE)');
  }
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, `Failed to fetch EPL events: ${res.status} ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as EplEvent[];
  if (!Array.isArray(data)) throw new ApiError(500, 'Invalid data from EPL API');
  cache = { data, fetchedAt: Date.now() };
  return data;
};

export const listEplEvents = async (filters: Record<string, unknown> = {}) => {
  const all = await fetchEplEvents(!!filters.force);
  let filtered = all;

  const search = typeof filters.search === 'string' ? filters.search.trim().toLowerCase() : '';
  if (search) {
    filtered = filtered.filter(
      (e) =>
        e.id.toLowerCase().includes(search) ||
        e.sport_key.toLowerCase().includes(search) ||
        e.sport_title.toLowerCase().includes(search) ||
        e.home_team.toLowerCase().includes(search) ||
        e.away_team.toLowerCase().includes(search) ||
        e.commence_time.toLowerCase().includes(search)
    );
  }

  const page = Math.max(1, parseInt(String(filters.page ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(filters.limit ?? '20'), 10) || 20));
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * limit;
  const data = filtered.slice(start, start + limit);

  return {
    data,
    total,
    page: currentPage,
    limit,
    totalPages,
  };
};

export const clearCache = () => {
  cache = null;
};

async function ensureEplCompetition() {
  let sport = await prisma.sport.findFirst({ where: { slug: 'soccer' } });
  if (!sport) {
    sport = await prisma.sport.findFirst({ where: { gameType: 'SOCCER' } });
  }
  if (!sport) {
    sport = await prisma.sport.create({
      data: { name: 'Soccer', slug: 'soccer', gameType: 'SOCCER' },
    });
  }
  let competition = await prisma.competition.findFirst({ where: { sportId: sport.id, name: { contains: 'Premier' } } });
  if (!competition) {
    // try EPL exact
    competition = await prisma.competition.findFirst({ where: { sportId: sport.id, name: 'EPL' } });
  }
  if (!competition) {
    competition = await prisma.competition.create({
      data: { name: 'English Premier League', country: 'England', sportId: sport.id },
    });
  }
  return competition;
}

export const publishEplEvent = async (eventId: string) => {
  const all = await fetchEplEvents(false);
  const ev = all.find((e) => e.id === eventId);
  if (!ev) throw new ApiError(404, 'EPL event not found');

  const existing = await prisma.game.findUnique({ where: { externalEventId: ev.id } });
  if (existing) throw new ApiError(409, 'Game already added');

  const competition = await ensureEplCompetition();

  const game = await prisma.game.create({
    data: {
      competitionId: competition.id,
      homeTeam: ev.home_team,
      awayTeam: ev.away_team,
      startTime: new Date(ev.commence_time),
      status: 'SCHEDULED',
      externalEventId: ev.id,
      isPublished: false,
      specifications: { sport_key: ev.sport_key, sport_title: ev.sport_title } as never,
    },
    include: { competition: { include: { sport: true } } },
  });

  // If the game starts within 48h, fetch & save odds JSON immediately
  const hoursToStart = (new Date(ev.commence_time).getTime() - Date.now()) / (1000 * 60 * 60);
  if (hoursToStart <= 48) {
    try {
      await eplGameOdds.fetchAndSaveGameOdds(ev.id);
    } catch (e) {
      console.warn(`[publishEplEvent] immediate odds fetch failed for ${ev.id}:`, e instanceof Error ? e.message : String(e));
    }
  }

  return game;
};

export const publishEplEventsBulk = async (eventIds: string[]) => {
  const results: { id: string; success: boolean; message: string; game?: unknown }[] = [];
  for (const id of [...new Set(eventIds)]) {
    try {
      const game = await publishEplEvent(id);
      results.push({ id, success: true, message: 'Added', game });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      results.push({ id, success: false, message: msg });
    }
  }
  return results;
};

export const getPublishedEventIds = async (): Promise<Set<string>> => {
  const games = await prisma.game.findMany({
    where: { externalEventId: { not: null } },
    select: { externalEventId: true },
  });
  return new Set(games.map((g) => g.externalEventId as string).filter(Boolean));
};
