import cron from 'node-cron';
import { runSyncGameResults } from './operations/sync-game-results.js';
import { runRefreshGameOddsJob } from './operations/refresh-game-odds.js';
import { runReferralBonusCheck } from './operations/referral-bonus-check.js';
import { runBonusExpiryCheck } from './operations/bonus-expiry-check.js';

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

  // Referral bonus top-up: every 12h, pay pending referrals whose referee
  // balance has reached the live qualifying threshold (skips rewarded ones)
  cron.schedule('0 */12 * * *', async () => {
    try {
      const r = await runReferralBonusCheck();
      if (r.rewarded || r.errored) {
        console.log(`[jobs] referral-bonus-check: checked=${r.checked} rewarded=${r.rewarded} skippedLow=${r.skippedLowBalance} skippedInactive=${r.skippedInactive} errored=${r.errored}`);
        for (const d of r.details) console.log(`  referral ${d.referralId}: paid ETB ${d.amount} to ${d.referrerId}`);
      }
    } catch (e) {
      console.error('[jobs] referral-bonus-check failed', e);
    }
  });

  // First-deposit bonus expiry: daily, take back whatever locked bonus is left
  // past the live bonus.expiry_days window (ledgered as BONUS_EXPIRED)
  cron.schedule('0 3 * * *', async () => {
    try {
      const r = await runBonusExpiryCheck();
      if (r.swept || r.errored) {
        console.log(`[jobs] bonus-expiry-check: checked=${r.checked} swept=${r.swept} deducted=${r.deducted} errored=${r.errored}`);
        for (const d of r.details) console.log(`  user ${d.userId}: removed ETB ${d.deducted}`);
      }
    } catch (e) {
      console.error('[jobs] bonus-expiry-check failed', e);
    }
  });

  console.log('[jobs] scheduler started: sync-game-results (every 10 min), refresh-game-odds (every 5 min, tiered), referral-bonus-check (every 12 h), bonus-expiry-check (daily 03:00)');
}

export default startJobs;
