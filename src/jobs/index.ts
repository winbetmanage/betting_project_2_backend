import cron from 'node-cron';
import { runSyncGameResults } from './operations/sync-game-results.js';

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

  console.log('[jobs] scheduler started: sync-game-results (every 10 min)');
}

export default startJobs;
