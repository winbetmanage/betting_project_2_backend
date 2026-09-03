import fs from 'fs';
import path from 'path';
import prisma from '../../utils/prisma.js';
import { FetchEplEvents } from '../../../codes.js';

type EplEvent = {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
};

const LIVE_WINDOW_HOURS = 3;

function inferStatus(commenceIso: string): string {
  const now = new Date();
  const commence = new Date(commenceIso);
  const diffHours = (now.getTime() - commence.getTime()) / (1000 * 60 * 60);

  if (diffHours < 0) return 'SCHEDULED';                 // not started yet
  if (diffHours >= 0 && diffHours < LIVE_WINDOW_HOURS) return 'LIVE'; // within match window
  if (diffHours >= LIVE_WINDOW_HOURS) return 'FINISHED'; // past match window
  return 'SCHEDULED';
}

export async function runFetchEplEventsJob() {
  const timestamp = new Date().toISOString();
  try {
    const url = FetchEplEvents;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Fetch failed ${res.status} ${text.slice(0, 200)}`);
    }
    const events = (await res.json()) as unknown[];
    if (!Array.isArray(events)) throw new Error('Invalid response: expected array');

    const fetchedCount = events.length;
    const eventMap = new Map<string, EplEvent>();
    for (const e of events as EplEvent[]) {
      if (e?.id) eventMap.set(e.id, e);
    }

    // Write JSON snapshot (audit only)
    try {
      const storePath = path.join(process.cwd(), 'json_store', 'static_data', 'epl_events.json');
      const altPath = path.join(process.cwd(), 'Back-end', 'json_store', 'static_data', 'epl_events.json');
      const targetPath = fs.existsSync(path.dirname(storePath)) ? storePath : altPath;
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, JSON.stringify(events, null, 2), 'utf-8');
    } catch (e) {
      console.warn(`[fetch-epl-events] ${timestamp} - warning: failed to write JSON snapshot`, e instanceof Error ? e.message : String(e));
    }

    // Get all DB games with an externalEventId
    const dbGames = await prisma.game.findMany({
      where: { externalEventId: { not: null } },
    });

    let updatedCount = 0;
    let transitionCount = 0;

    for (const game of dbGames) {
      const extId = game.externalEventId as string;
      const newEvent = eventMap.get(extId);

      let newStatus: string | null = null;
      if (!newEvent) {
        // Game not in fetched schedule — only end it if startTime + 90min has passed
        const gameStart = new Date(game.startTime);
        const ninetyMinLater = new Date(gameStart.getTime() + 90 * 60 * 1000);
        if (new Date() >= ninetyMinLater) {
          newStatus = 'FINISHED';
        } else {
          // Start time hasn't surpassed 90min yet — keep current status
          continue;
        }
      } else {
        newStatus = inferStatus(newEvent.commence_time);
      }

      if (!newStatus || newStatus === game.status) continue;

      // Only transition games that are currently active or being ended
      // (avoid resurrecting already-settled/cancelled games)
      if (!['SCHEDULED', 'LIVE', 'SUSPENDED', 'FINISHED'].includes(game.status)) continue;
      if (game.status === 'FINISHED' && newStatus === 'FINISHED') continue;

      const specifications = (game.specifications as Record<string, unknown> | null) ?? {};
      await prisma.game.update({
        where: { id: game.id },
        data: {
          status: newStatus as never,
          specifications: {
            ...specifications,
            lastFetchedAt: timestamp,
            fetchedEvent: newEvent
              ? {
                  id: newEvent.id,
                  sport_key: newEvent.sport_key,
                  sport_title: newEvent.sport_title,
                  commence_time: newEvent.commence_time,
                }
              : null,
          },
        },
      });

      updatedCount++;
      if (game.status !== newStatus) {
        transitionCount++;
        console.log(
          `[fetch-epl-events] ${timestamp} - status transition: Game ${game.id} (${game.homeTeam} vs ${game.awayTeam} ${extId}) ${game.status} → ${newStatus}`
        );
      }
    }

    console.log(
      `[fetch-epl-events] ${timestamp} - fetched ${fetchedCount} events, updated ${updatedCount} games, ${transitionCount} status transitions`
    );
    return { fetchedCount, updatedCount, transitionCount };
  } catch (err) {
    console.error(`[fetch-epl-events] ${timestamp} - failed:`, err instanceof Error ? err.message : String(err));
    return { fetchedCount: 0, updatedCount: 0, transitionCount: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export default runFetchEplEventsJob;
