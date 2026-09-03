import cron from 'node-cron';
import { runFetchEplEventsJob } from './operations/fetch-epl-events.js';
import { runFetchEplGameOddsJob } from './operations/fetch-epl-game-odds.js';
import { runRefreshEplOddsCheckpointsJob } from './operations/refresh-epl-odds-checkpoints.js';
import { runFundRequestProofCleanupJob } from './operations/fund-request-proof-cleanup.js';

export function startJobs() {
  // Every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    await runFetchEplEventsJob(); // schedule/status sync (kept)
    await runFetchEplGameOddsJob(); // fetch+save JSON for <48h games (on-demand first fetch)
  });

  // Every 5 minutes — refresh selected markets at 24h / 3h / 15m checkpoints
  cron.schedule('*/5 * * * *', async () => {
    await runRefreshEplOddsCheckpointsJob();
  });

  // Every Sunday at 3:00 AM — clean up proof images for stale REJECTED / CANCELLED requests
  cron.schedule('0 3 * * 0', async () => {
    await runFundRequestProofCleanupJob();
  });

  console.log('[jobs] scheduler started: fetch-epl-events, fetch-epl-game-odds, refresh-epl-odds-checkpoints, fund-request-proof-cleanup (weekly)');
  setTimeout(() => {
    runFetchEplEventsJob()
      .then(() => runFetchEplGameOddsJob())
      .then(() => runRefreshEplOddsCheckpointsJob())
      .catch((e) => console.error('[jobs] initial run failed', e));
  }, 5000);
}

export default startJobs;
