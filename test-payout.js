const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  // Create a pending 120 ETB deposit for reftest3, then simulate admin approval via service logic check
  const referee = await prisma.user.findUnique({ where: { email: 'reftest3@example.com' } });
  if (!referee) throw new Error('reftest3 not found');
  const referrer = await prisma.user.findUnique({ where: { email: 'janedoe@gmail.com' } });

  const req = await prisma.fundRequest.create({
    data: {
      userId: referee.id,
      type: 'DEPOSIT',
      amount: 120,
      status: 'PENDING',
    },
  });
  console.log('deposit request created:', req.id);

  // Simulate what approveRequest does (the referral part):
  const REFERRAL_QUALIFY_AMOUNT = 100;
  const pending = await prisma.referral.findFirst({
    where: { refereeId: referee.id, status: 'PENDING' },
  });
  console.log('pending referral found:', pending ? pending.id : 'NO');

  const claimed = await prisma.referral.updateMany({
    where: { id: pending.id, status: 'PENDING' },
    data: { status: 'REWARDED', qualifiedAt: new Date(), rewardedAt: new Date() },
  });
  console.log('claimed count:', claimed.count);

  if (claimed.count === 1) {
    const updated = await prisma.user.update({
      where: { id: referrer.id },
      data: { balance: { increment: 50 } },
    });
    const txr = await prisma.transaction.create({
      data: {
        userId: referrer.id,
        type: 'REFERRAL_BONUS',
        amount: 50,
        balanceAfter: Number(updated.balance),
        reference: `referral:${pending.id}`,
      },
    });
    console.log('referrer new balance:', updated.balance.toString());
    console.log('bonus transaction created:', txr.id);
  }

  // cleanup: refund the referrer balance and delete bonus tx + the fake request + flip referral back
  await prisma.transaction.delete({ where: { id: txr.id } });
  await prisma.user.update({ where: { id: referrer.id }, data: { balance: { decrement: 50 } } });
  await prisma.referral.update({ where: { id: pending.id }, data: { status: 'PENDING', qualifiedAt: null, rewardedAt: null } });
  await prisma.fundRequest.delete({ where: { id: req.id } });
  console.log('cleaned up — referral is PENDING again, ready for real test');
  await prisma.$disconnect();
})().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});
