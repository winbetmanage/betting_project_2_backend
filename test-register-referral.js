const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  // Replicate auth.service.register referral block exactly
  const email = 'reftest2@example.com';
  const code = 'cmtr9m0se0007ve28y4vwp383'; // Jan's referralCode

  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) {
    console.log('reftest2 already exists — deleting first');
    await prisma.user.delete({ where: { id: exists.id } }).catch((e) => console.log('delete failed (FK?):', e.message));
  }

  const referrer = await prisma.user.findUnique({ where: { referralCode: code } });
  console.log('referrer found:', referrer ? `${referrer.name} (${referrer.email})` : 'NO');

  const passwordHash = 'fakehash';
  const user = await prisma.user.create({ data: { email, name: 'RefTest2', passwordHash } });
  console.log('user created:', user.id);

  try {
    const referral = await prisma.referral.create({
      data: { referrerId: referrer.id, refereeId: user.id, codeUsed: code, status: 'PENDING' },
    });
    console.log('REFERRAL CREATED:', referral.id, referral.status);
  } catch (e) {
    console.error('REFERRAL CREATE FAILED:', e.message);
    if (e.code) console.error('code:', e.code);
  }

  // check model presence
  console.log('prisma.referral exists:', typeof prisma.referral);
  await prisma.$disconnect();
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
