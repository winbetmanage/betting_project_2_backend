import cron from 'node-cron';
import { runSyncGameResults } from './operations/sync-game-results.js';
import { runRefreshGameOddsJob } from './operations/refresh-game-odds.js';

export function startJobs() {
  cron.schedule('*/10 * * * *', async () => {
    try {
      const r = await runSyncGameResults();
      if (r.checked || r.updated || r.stagedUpdated) {
        console.log(`[jobs] sync-game-results: checked=${r.checked} updated=${r.updated} finished=${r.finished} stagedUpdated=${r.stagedUpdated} noFD=${r.skippedNoFd} errors=${r.errors}`);
      }
    } catch (e) {
      console.error('[jobs] sync-game-results failed', e);
    }
  });

  // Tiered odds refresh: >7d:24h, 7d-3d:12h, 3d-24h:6h, 24h-6h:3h, <6h:30m, started:stop
  cron.schedule('*/5 * * * *', async () => {
    try {
      const r = await runRefreshGameOddsJob();
      if (r.due || r.errored) {
        console.log(`[jobs] refresh-game-odds: candidates=${r.candidates} due=${r.due} refreshed=${r.refreshed} fresh=${r.fresh} errored=${r.errored}`);
        for (const d of r.details) console.log(`  ${d.fixture}: ${d.oddsChanged} odds changed across ${d.marketsUpdated} markets${d.notes.length ? ` — notes: ${d.notes.join(' | ')}` : ''}`);
      }
    } catch (e) {
      console.error('[jobs] refresh-game-odds failed', e);
    }
  });

  console.log('[jobs] scheduler started: sync-game-results (every 10 min), refresh-game-odds (every 5 min, tiered)');
}

export default startJobs;
