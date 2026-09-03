import cron from 'node-cron';
import { runFetchEplEventsJob } from './operations/fetch-epl-events.js';
import { runFetchEplGameOddsJob } from './operations/fetch-epl-game-odds.js';
import { runRefreshEplOddsCheckpointsJob } from './operations/refresh-epl-odds-checkpoints.js';

export function startJobs() {
  cron.schedule('*/5 * * * *', async () => {
    await runFetchEplEventsJob();
    await runFetchEplGameOddsJob();
  });
  cron.schedule('*/5 * * * *', async () => {
    await runRefreshEplOddsCheckpointsJob();
  });
  console.log('[jobs] scheduler started: fetch-epl-events, fetch-epl-game-odds, refresh-epl-odds-checkpoints every 5 minutes');
  setTimeout(() => {
    runFetchEplEventsJob()
      .then(() => runFetchEplGameOddsJob())
      .then(() => runRefreshEplOddsCheckpointsJob())
      .catch((e) => console.error('[jobs] initial run failed', e));
  }, 5000);
}

export default startJobs;
