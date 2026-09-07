import prisma from '../../utils/prisma.js';
import { FetchEplEvents } from '../../../codes.js';

const MATCH_END_GRACE_MINUTES = 90;
const LIVE_WINDOW_HOURS = 3;
const ACTIVE_STATUSES = ['SCHEDULED', 'LIVE', 'SUSPENDED'] as const;

type FetchedEvent = { id?: string; commence_time?: string };

export async function runEndFinishedGamesJob() {
  const timestamp = new Date().toISOString();
  try {
    // Fetch the current schedule from the odds API
    const res = await fetch(FetchEplEvents);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Fetch failed ${res.status} ${text.slice(0, 200)}`);
    }
    const events = (await res.json()) as unknown;
    const eventMap = new Map<string, string>(); // externalEventId -> commence_time
    if (Array.isArray(events)) {
      for (const e of events as FetchedEvent[]) {
        if (e?.id) eventMap.set(e.id, e.commence_time ?? '');
      }
    }

    const now = Date.now();

    // All currently active games
    const activeGames = await prisma.game.findMany({
      where: { status: { in: ACTIVE_STATUSES as never } },
      select: {
        id: true,
        homeTeam: true,
        awayTeam: true,
        startTime: true,
        externalEventId: true,
        specifications: true,
      },
    });

    let endedCount = 0;

    for (const game of activeGames) {
      const startTime = new Date(game.startTime).getTime();
      const graceEnd = startTime + MATCH_END_GRACE_MINUTES * 60 * 1000;

      let shouldEnd = false;
      let reason = '';

      const extId = game.externalEventId;
      if (extId) {
        const commence = eventMap.get(extId);
        if (commence) {
          // Still listed — end only if its live window has fully passed
          if (now >= new Date(commence).getTime() + LIVE_WINDOW_HOURS * 3600 * 1000) {
            shouldEnd = true;
            reason = 'live window passed (still listed)';
          }
        } else if (now >= graceEnd) {
          // Dropped off the fetched schedule and kickoff + 90min passed
          shouldEnd = true;
          reason = 'no longer in fetched schedule';
        }
      } else if (now >= graceEnd) {
        // Local game without external source — end by time
        shouldEnd = true;
        reason = 'start time + 90min passed';
      }

      if (!shouldEnd) continue;

      const specifications = (game.specifications as Record<string, unknown> | null) ?? {};
      await prisma.game.update({
        where: { id: game.id },
        data: {
          status: 'FINISHED' as never,
          specifications: { ...specifications, endedAt: timestamp, endedReason: reason },
        },
      });

      endedCount++;
      console.log(
        `[end-finished-games] ${timestamp} - ended Game ${game.id} (${game.homeTeam} vs ${game.awayTeam}) - ${reason}`
      );
    }

    console.log(`[end-finished-games] ${timestamp} - active checked ${activeGames.length}, ended ${endedCount}`);
    return { checked: activeGames.length, ended: endedCount };
  } catch (err) {
    console.error(`[end-finished-games] ${timestamp} - failed:`, err instanceof Error ? err.message : String(err));
    return { checked: 0, ended: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export default runEndFinishedGamesJob;
