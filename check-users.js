const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const users = await p.user.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, email: true, name: true, role: true, referralCode: true, balance: true, createdAt: true },
  });
  console.log('=== USERS (latest 10) ===');
  console.log(JSON.stringify(users, null, 1));
  await p.$disconnect();
})().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});
