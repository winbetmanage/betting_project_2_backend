import prisma from '../../utils/prisma.js';
import { getNumberSetting } from '../../services/settings.service.js';

const BONUS_FALLBACK = 50;
const QUALIFY_FALLBACK = 100;

export type ReferralBonusSummary = {
  checked: number;
  rewarded: number;
  skippedLowBalance: number;
  skippedInactive: number;
  errored: number;
  details: { referralId: string; referrerId: string; amount: number }[];
};

let running = false;

/**
 * Every 12h: for each PENDING referral (bonus not yet rewarded because of
 * this referee), check the referee's CURRENT total balance against the
 * live `referral.qualifying_deposit` setting. If balance >= threshold,
 * pay the live `referral.bonus_amount` to the referrer and flip the row to
 * REWARDED so it never pays again.
 *
 * The conditional updateMany (WHERE status='PENDING') is the double-pay
 * guard — safe to run alongside the approval-time reward path.
 */
export async function runReferralBonusCheck(): Promise<ReferralBonusSummary> {
  const summary: ReferralBonusSummary = {
    checked: 0,
    rewarded: 0,
    skippedLowBalance: 0,
    skippedInactive: 0,
    errored: 0,
    details: [],
  };
  if (running) return summary;
  running = true;
  try {
    const bonusAmount = await getNumberSetting('referral.bonus_amount', BONUS_FALLBACK);
    const qualifying = await getNumberSetting('referral.qualifying_deposit', QUALIFY_FALLBACK);

    const pending = await prisma.referral.findMany({
      where: { status: 'PENDING' },
      select: {
        id: true,
        referrerId: true,
        referrer: { select: { id: true } },
        referee: { select: { id: true, balance: true, isActive: true } },
      },
    });
    summary.checked = pending.length;

    for (const ref of pending) {
      try {
        if (!ref.referee || !ref.referee.isActive || !ref.referrer) {
          summary.skippedInactive++;
          continue;
        }
        if (Number(ref.referee.balance) < qualifying) {
          summary.skippedLowBalance++;
          continue;
        }
        const paid = await prisma.$transaction(async (tx) => {
          const claimed = await tx.referral.updateMany({
            where: { id: ref.id, status: 'PENDING' },
            data: { status: 'REWARDED', bonusAmount, qualifiedAt: new Date(), rewardedAt: new Date() },
          });
          if (claimed.count !== 1) return false;
          const updatedReferrer = await tx.user.update({
            where: { id: ref.referrerId },
            data: { balance: { increment: bonusAmount } },
          });
          await tx.transaction.create({
            data: {
              userId: ref.referrerId,
              type: 'REFERRAL_BONUS',
              amount: bonusAmount,
              balanceAfter: Number(updatedReferrer.balance),
              reference: `referral:${ref.id}`,
            },
          });
          return true;
        }, { maxWait: 10_000, timeout: 20_000 });
        if (paid) {
          summary.rewarded++;
          summary.details.push({ referralId: ref.id, referrerId: ref.referrerId, amount: bonusAmount });
        } else {
          summary.skippedInactive++; // lost the race (already claimed elsewhere) — won't retry
        }
      } catch (e) {
        summary.errored++;
        console.error(`[referral-bonus-check] referral ${ref.id} failed:`, e instanceof Error ? e.message : String(e));
      }
    }
    return summary;
  } finally {
    running = false;
  }
}

export default runReferralBonusCheck;
