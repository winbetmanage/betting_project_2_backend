import prisma from '../../utils/prisma.js';
import { getNumberSetting } from '../../services/settings.service.js';
import { sweepExpiredBonusInTx } from '../../services/fundRequest.service.js';
import { notify } from '../../services/notification.service.js';

const EXPIRY_DAYS_FALLBACK = 7;

export type BonusExpirySummary = {
  checked: number;
  swept: number;
  deducted: number;
  errored: number;
  details: { userId: string; deducted: number }[];
};

let running = false;

/**
 * Daily: remove expired first-deposit bonuses. Any account whose locked bonus
 * grant is older than the live `bonus.expiry_days` setting has whatever of it
 * still exists deducted from the balance and the lock zeroed (ledgered as
 * BONUS_EXPIRED). Accounts that already wagered the bonus have nothing left
 * to take, so the sweep is a no-op for them.
 */
export async function runBonusExpiryCheck(): Promise<BonusExpirySummary> {
  const summary: BonusExpirySummary = { checked: 0, swept: 0, deducted: 0, errored: 0, details: [] };
  if (running) return summary;
  running = true;
  try {
    const expiryDays = await getNumberSetting('bonus.expiry_days', EXPIRY_DAYS_FALLBACK);
    const cutoff = new Date(Date.now() - expiryDays * 86400_000);

    const candidates = await prisma.user.findMany({
      where: { lockedBonus: { gt: 0 }, bonusGrantedAt: { lte: cutoff } },
      select: { id: true },
    });
    summary.checked = candidates.length;

    for (const c of candidates) {
      try {
        const deducted = await prisma.$transaction(async (tx) => {
          return sweepExpiredBonusInTx(tx, c.id, expiryDays);
        }, { maxWait: 10_000, timeout: 20_000 });
        summary.swept++;
        if (deducted > 0) {
          summary.deducted = Math.round((summary.deducted + deducted) * 100) / 100;
          summary.details.push({ userId: c.id, deducted });
          await notify({
            audience: 'USER',
            userId: c.id,
            type: 'BONUS_EXPIRED',
            title: `Bonus expired — ETB ${deducted.toFixed(2)} removed`,
            message: 'Your first-deposit bonus was only valid for betting within its expiry window.',
            linkUrl: '/wallet',
          }).catch(() => {});
        }
      } catch (e) {
        summary.errored++;
        console.error(`[bonus-expiry-check] user ${c.id} failed:`, e instanceof Error ? e.message : String(e));
      }
    }
    return summary;
  } finally {
    running = false;
  }
}

export default runBonusExpiryCheck;
