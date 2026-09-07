const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const referrals = await p.referral.findMany({
    take: 20,
    orderBy: { createdAt: 'desc' },
    include: {
      referrer: { select: { email: true, name: true } },
      referee: { select: { email: true, name: true } },
    },
  });
  console.log('=== REFERRALS ===');
  console.log(JSON.stringify(referrals, null, 1));

  const bonusTx = await p.transaction.findMany({
    where: { type: 'REFERRAL_BONUS' },
    take: 10,
    orderBy: { createdAt: 'desc' },
  });
  console.log('=== REFERRAL_BONUS TRANSACTIONS ===');
  console.log(JSON.stringify(bonusTx, null, 1));

  const recentDeposits = await p.fundRequest.findMany({
    where: { type: 'DEPOSIT' },
    take: 10,
    orderBy: { createdAt: 'desc' },
    select: { id: true, userId: true, amount: true, status: true, createdAt: true },
  });
  console.log('=== RECENT DEPOSITS ===');
  console.log(JSON.stringify(recentDeposits, null, 1));

  await p.$disconnect();
})().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});
