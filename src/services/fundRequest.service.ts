import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';

const MIN_AMOUNT = 100;
const MAX_PENDING_DEPOSITS = 3;
const REFERRAL_QUALIFY_AMOUNT = 100; // referee's deposit must be at least this for the referrer to earn the bonus

// Slow remote MySQL + extra referral work can exceed the 5s default
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

export async function createDepositRequest(
  userId: string,
  data: { id?: string; amount: number; transferAccountId: string; senderReference?: string; proofImagePath?: string }
) {
  if (!data.amount || data.amount < MIN_AMOUNT) throw new ApiError(400, `Minimum deposit is ${MIN_AMOUNT}`);

  const pending = await prisma.fundRequest.count({ where: { userId, type: 'DEPOSIT', status: 'PENDING' } });
  if (pending >= MAX_PENDING_DEPOSITS) throw new ApiError(400, `Max ${MAX_PENDING_DEPOSITS} pending deposits allowed`);

  const account = await prisma.ourTransferAccount.findUnique({ where: { id: data.transferAccountId } });
  if (!account?.status) throw new ApiError(400, 'Transfer account not available');

  return prisma.fundRequest.create({
    data: {
      ...(data.id ? { id: data.id } : {}),
      userId,
      type: 'DEPOSIT',
      amount: data.amount,
      status: 'PENDING',
      transferAccountId: data.transferAccountId,
      senderReference: data.senderReference,
      proofImagePath: data.proofImagePath,
    },
  });
}

export async function createWithdrawalRequest(
  userId: string,
  data: { amount: number; payoutAccountName: string; payoutAccountNumber: string; payoutBankName: string }
) {
  if (!data.amount || data.amount < MIN_AMOUNT) throw new ApiError(400, `Minimum withdrawal is ${MIN_AMOUNT}`);
  if (!data.payoutAccountName || !data.payoutAccountNumber || !data.payoutBankName) throw new ApiError(400, 'Payout account details required');

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new ApiError(404, 'User not found');
    if (!user.isActive) throw new ApiError(403, 'Account inactive');

    const available = Number(user.balance) - Number(user.heldBalance);
    if (data.amount > available) throw new ApiError(400, 'Insufficient available balance');

    const request = await tx.fundRequest.create({
      data: {
        userId,
        type: 'WITHDRAWAL',
        amount: data.amount,
        status: 'PENDING',
        payoutAccountName: data.payoutAccountName,
        payoutAccountNumber: data.payoutAccountNumber,
        payoutBankName: data.payoutBankName,
      },
    });

    await tx.user.update({ where: { id: userId }, data: { heldBalance: { increment: data.amount } } });
    return request;
  }, TX_OPTIONS);
}

export async function approveRequest(requestId: string, adminId: string) {
  return prisma.$transaction(async (tx) => {
    const req = await tx.fundRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new ApiError(404, 'Request not found');
    if (req.status !== 'PENDING') throw new ApiError(400, 'Request is not pending');

    const user = await tx.user.findUnique({ where: { id: req.userId } });
    if (!user) throw new ApiError(404, 'User not found');

    if (req.type === 'WITHDRAWAL') {
      const available = Number(user.balance) - Number(user.heldBalance);
      if (Number(req.amount) > available) throw new ApiError(400, 'User no longer has sufficient balance');
    }

    // Update balances
    if (req.type === 'WITHDRAWAL') {
      await tx.user.update({ where: { id: req.userId }, data: { balance: { decrement: req.amount }, heldBalance: { decrement: req.amount } } });
    } else {
      // Deposit: credit the balance (no heldBalance involved)
      await tx.user.update({ where: { id: req.userId }, data: { balance: { increment: req.amount } } });
    }

    // Create Transaction (ledger entry)
    const txType = req.type === 'DEPOSIT' ? 'DEPOSIT' : 'WITHDRAWAL';
    const balanceAfter = req.type === 'DEPOSIT' ? Number(user.balance) + Number(req.amount) : Number(user.balance) - Number(req.amount);

    const transaction = await tx.transaction.create({
      data: {
        userId: req.userId,
        type: txType as never,
        amount: req.amount,
        balanceAfter: Math.round(balanceAfter * 100) / 100,
        fundRequestId: req.id,
      },
    });

    // Update request
    await tx.fundRequest.update({
      where: { id: requestId },
      data: { status: 'APPROVED', reviewedById: adminId, reviewedAt: new Date() },
    });

    // Referral payout — only on qualifying DEPOSIT approvals.
    // The conditional updateMany (WHERE status='PENDING') is the double-pay guard:
    // only one concurrent approval can win the race and flip the status.
    if (req.type === 'DEPOSIT' && Number(req.amount) >= REFERRAL_QUALIFY_AMOUNT) {
      const referral = await tx.referral.findFirst({
        where: { refereeId: req.userId, status: 'PENDING' },
        include: { referrer: { select: { id: true, balance: true } } },
      });
      if (referral) {
        const claimed = await tx.referral.updateMany({
          where: { id: referral.id, status: 'PENDING' },
          data: { status: 'REWARDED', qualifiedAt: new Date(), rewardedAt: new Date() },
        });
        if (claimed.count === 1) {
          const updatedReferrer = await tx.user.update({
            where: { id: referral.referrerId },
            data: { balance: { increment: referral.bonusAmount } },
          });
          await tx.transaction.create({
            data: {
              userId: referral.referrerId,
              type: 'REFERRAL_BONUS',
              amount: referral.bonusAmount,
              balanceAfter: Number(updatedReferrer.balance),
              reference: `referral:${referral.id}`,
            },
          });
        }
      }
    }

    return { request: req, transaction };
  }, TX_OPTIONS);
}

export async function rejectRequest(requestId: string, adminId: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const req = await tx.fundRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new ApiError(404, 'Request not found');
    if (req.status !== 'PENDING') throw new ApiError(400, 'Request is not pending');

    // Release held balance (withdrawals only)
    if (req.type === 'WITHDRAWAL') {
      await tx.user.update({ where: { id: req.userId }, data: { heldBalance: { decrement: req.amount } } });
    }

    await tx.fundRequest.update({
      where: { id: requestId },
      data: { status: 'REJECTED', reviewedById: adminId, reviewedAt: new Date(), rejectionReason: reason || null },
    });

    return req;
  }, TX_OPTIONS);
}

export async function cancelRequest(requestId: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    const req = await tx.fundRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new ApiError(404, 'Request not found');
    if (req.userId !== userId) throw new ApiError(403, 'Not your request');
    if (req.status !== 'PENDING') throw new ApiError(400, 'Request is not pending');

    if (req.type === 'WITHDRAWAL') {
      await tx.user.update({ where: { id: userId }, data: { heldBalance: { decrement: req.amount } } });
    }

    await tx.fundRequest.update({ where: { id: requestId }, data: { status: 'CANCELLED' } });
    return req;
  }, TX_OPTIONS);
}

export async function listMyRequests(userId: string, filters: Record<string, unknown> = {}) {
  const where: Record<string, unknown> = { userId };
  if (filters.type) where.type = filters.type;
  if (filters.status) where.status = filters.status;
  return prisma.fundRequest.findMany({ where: where as never, orderBy: { createdAt: 'desc' } });
}

export async function adminListRequests(filters: Record<string, unknown> = {}) {
  const where: Record<string, unknown> = {};
  if (filters.type) where.type = filters.type;
  if (filters.status) where.status = filters.status;
  if (filters.userId) where.userId = filters.userId;
  return prisma.fundRequest.findMany({
    where: where as never,
    include: { user: { select: { id: true, email: true, name: true } }, transferAccount: true, reviewedBy: { select: { id: true, email: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getRequestById(requestId: string) {
  const req = await prisma.fundRequest.findUnique({
    where: { id: requestId },
    include: { user: { select: { id: true, email: true, name: true } }, transferAccount: true, reviewedBy: { select: { id: true, email: true, name: true } }, transaction: true },
  });
  if (!req) throw new ApiError(404, 'Request not found');
  return req;
}

export async function getMyAvailableBalance(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { balance: true, heldBalance: true } });
  if (!user) return { balance: 0, heldBalance: 0, available: 0 };
  return { balance: Number(user.balance), heldBalance: Number(user.heldBalance), available: Number(user.balance) - Number(user.heldBalance) };
}