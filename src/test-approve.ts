import prisma from './utils/prisma';
import * as fundRequestService from './services/fundRequest.service';

async function withRetry<T>(fn: () => Promise<T>, tries = 8, waitMs = 8000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Server has closed') || msg.includes('max_statement_time') || msg.includes("Can't reach")) {
        console.log(`  (db busy, retry ${i + 1}/${tries} in ${waitMs}ms)`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function main() {
  const referee = await withRetry(() => prisma.user.findUnique({ where: { email: 'reftest3@example.com' } }));
  const referrer = await withRetry(() => prisma.user.findUnique({ where: { email: 'janedoe@gmail.com' } }));
  const admin = await withRetry(() => prisma.user.findUnique({ where: { email: 'adminone@gmail.com' } }));
  if (!referee || !referrer || !admin) throw new Error('users missing');
  console.log('users OK | referrer balance before:', Number(referrer.balance));

  await withRetry(() => prisma.fundRequest.deleteMany({ where: { userId: referee.id } }));

  // reset referral to PENDING if a previous run consumed it
  await withRetry(() =>
    prisma.referral.updateMany({
      where: { refereeId: referee.id, status: { not: 'PENDING' } },
      data: { status: 'PENDING', qualifiedAt: null, rewardedAt: null },
    })
  );

  const request = await withRetry(() =>
    prisma.fundRequest.create({
      data: { userId: referee.id, type: 'DEPOSIT', amount: 120, status: 'PENDING' },
    })
  );
  console.log('pending deposit created:', request.id);

  console.log('approving via REAL approveRequest...');
  const result = await withRetry(() => fundRequestService.approveRequest(request.id, admin.id), 4);
  console.log('approved | ledger:', result.transaction.type, Number(result.transaction.amount));

  const after = await withRetry(() => prisma.user.findUnique({ where: { id: referrer.id } }));
  console.log('referrer balance AFTER:', Number(after!.balance), '| delta:', Number(after!.balance) - Number(referrer.balance));

  const bonusTx = await withRetry(() =>
    prisma.transaction.findFirst({
      where: { userId: referrer.id, type: 'REFERRAL_BONUS' },
      orderBy: { createdAt: 'desc' },
    })
  );
  console.log('REFERRAL_BONUS tx:', bonusTx ? `+${Number(bonusTx.amount)} ETB, ref=${bonusTx.reference}` : 'MISSING!');

  const referral = await withRetry(() => prisma.referral.findFirst({ where: { refereeId: referee.id } }));
  console.log('referral status:', referral?.status, '| qualifiedAt:', referral?.qualifiedAt?.toISOString() ?? null, '| rewardedAt:', referral?.rewardedAt?.toISOString() ?? null);

  console.log('re-approve (should be blocked):');
  await fundRequestService
    .approveRequest(request.id, admin.id)
    .then(() => console.log('  UNEXPECTED: second approve succeeded!'))
    .catch((e: Error) => console.log('  blocked as expected:', e.message));

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.message : e);
  process.exit(1);
});
