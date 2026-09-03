import prisma from '../../utils/prisma.js';
import * as eplGameOdds from '../../services/eplGameOdds.service.js';

const FETCH_WINDOW_HOURS = 48;

export async function runFetchEplGameOddsJob() {
  const timestamp = new Date().toISOString();
  try {
    // Games with an externalEventId that are upcoming/live/suspended
    const games = await prisma.game.findMany({
      where: {
        externalEventId: { not: null },
        status: { in: ['SCHEDULED', 'LIVE', 'SUSPENDED'] },
      },
      select: { id: true, externalEventId: true, homeTeam: true, awayTeam: true, startTime: true, status: true },
    });

    let fetched = 0;
    let skipped = 0;
    const now = new Date();

    for (const game of games) {
      const extId = game.externalEventId as string;

      // Only fetch if the game is within 48h of kickoff (not more than 48h remaining)
      const hoursToStart = (game.startTime.getTime() - now.getTime()) / (1000 * 60 * 60);
      if (hoursToStart > FETCH_WINDOW_HOURS) {
        skipped++; // more than 48h remaining — do not fetch yet
        continue;
      }

      // Skip if a JSON file already exists (only fetch once on first add)
      if (eplGameOdds.hasJsonFor(extId)) {
        skipped++;
        continue;
      }

      try {
        const bookmakers = await eplGameOdds.fetchAndSaveGameOdds(extId);
        fetched++;
        console.log(
          `[fetch-epl-game-odds] ${timestamp} - saved ${extId} (${game.homeTeam} vs ${game.awayTeam}) - ${bookmakers} bookmakers, ${hoursToStart.toFixed(1)}h to start`
        );
      } catch (e) {
        console.error(`[fetch-epl-game-odds] ${timestamp} - failed for ${extId}:`, e instanceof Error ? e.message : String(e));
      }
    }

    console.log(`[fetch-epl-game-odds] ${timestamp} - games ${games.length}, fetched ${fetched}, skipped ${skipped}`);
    return { games: games.length, fetched, skipped };
  } catch (err) {
    console.error(`[fetch-epl-game-odds] ${timestamp} - failed:`, err instanceof Error ? err.message : String(err));
    return { games: 0, fetched: 0, skipped: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export default runFetchEplGameOddsJob;
