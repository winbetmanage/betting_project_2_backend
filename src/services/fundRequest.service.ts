import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import { notify } from './notification.service';
import { getNumberSetting } from './settings.service';
import { NON_STAFF_ROLES } from './user.service';

const MIN_AMOUNT = 100;
const MAX_PENDING_DEPOSITS = 3;
const WITHDRAWAL_MIN_RESERVE = 100; // available balance must stay >= this after a withdrawal request
// Kill-switch: referral bonuses are PAUSED — no agent is rewarded for any
// deposit amount until this is flipped back to false.
export const REFERRAL_BONUS_PAUSED = true;
// Fallbacks if settings rows are missing; live values come from AppSetting
// (referral.bonus_amount / referral.qualifying_deposit), editable in admin settings.
const REFERRAL_BONUS_FALLBACK = 50;
const REFERRAL_QUALIFY_FALLBACK = 100;

// Slow remote MySQL + extra referral work can exceed the 5s default
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

export async function createDepositRequest(
  userId: string,
  data: { id?: string; amount: number; transferAccountId: string; senderReference?: string; proofImagePath?: string }
) {
  if (!data.amount) throw new ApiError(400, 'Amount is required');
  const minDeposit = await getNumberSetting('deposit.min_amount', MIN_AMOUNT);
  if (data.amount < minDeposit) throw new ApiError(400, `Minimum deposit is ${minDeposit}`);
  // At least one proof of payment is mandatory: transaction ID or screenshot.
  if (!data.senderReference?.trim() && !data.proofImagePath) {
    throw new ApiError(400, 'Provide a transaction ID or a screenshot');
  }

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
  }).then(async (request) => {
    const requester = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
    await notify({
      audience: 'ADMIN',
      userId,
      type: 'DEPOSIT_REQUESTED',
      title: `New deposit request — ETB ${Number(data.amount).toFixed(2)}`,
      message: `From ${requester?.name ?? requester?.email ?? userId}`,
      linkUrl: '/admin/wallet',
    });
    return request;
  });
}

export async function createWithdrawalRequest(
  userId: string,
  data: { amount: number; payoutAccountName?: string; payoutAccountNumber?: string; payoutBankName?: string }
) {
  if (!data.amount || data.amount < MIN_AMOUNT) throw new ApiError(400, `Minimum withdrawal is ${MIN_AMOUNT}`);

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new ApiError(404, 'User not found');
    if (!user.isActive) throw new ApiError(403, 'Account inactive');

    // Destination snapshot: explicit per-request values win, otherwise the
    // user's stored payout account. One of the two must be complete.
    const payoutAccountName = (data.payoutAccountName ?? '').trim() || user.payoutAccountUsername;
    const payoutAccountNumber = (data.payoutAccountNumber ?? '').trim() || user.payoutAccountNumber;
    const payoutBankName = (data.payoutBankName ?? '').trim() || user.payoutAccountType;
    if (!payoutAccountName || !payoutAccountNumber || !payoutBankName) {
      throw new ApiError(400, 'Set up your payout account first (profile), then request a withdrawal');
    }

    // Re-checked inside the transaction: race-safe against concurrent bets/requests
    const available = Number(user.balance) - Number(user.heldBalance);
    if (available - Number(data.amount) < WITHDRAWAL_MIN_RESERVE) {
      throw new ApiError(400, `Insufficient available balance — ETB ${WITHDRAWAL_MIN_RESERVE} must remain after a withdrawal`);
    }

    const request = await tx.fundRequest.create({
      data: {
        userId,
        type: 'WITHDRAWAL',
        amount: data.amount,
        status: 'PENDING',
        payoutAccountName,
        payoutAccountNumber,
        payoutBankName,
      },
    });

    await tx.user.update({ where: { id: userId }, data: { heldBalance: { increment: data.amount } } });
    return request;
  }, TX_OPTIONS).then(async (request) => {
    const requester = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
    await notify({
      audience: 'ADMIN',
      userId,
      type: 'WITHDRAWAL_REQUESTED',
      title: `New withdrawal request — ETB ${Number(data.amount).toFixed(2)}`,
      message: `From ${requester?.name ?? requester?.email ?? userId}`,
      linkUrl: '/admin/users/withdrawal-requests',
    });
    return request;
  });
}

export async function approveRequest(
  requestId: string,
  adminId: string,
  evidence?: { transactionId?: string; completionProofImagePath?: string }
) {
  const txId = (evidence?.transactionId ?? '').trim();
  const proofPath = (evidence?.completionProofImagePath ?? '').trim();

  // Live referral policy (admin-editable); changes apply to pending referrals immediately
  const referralBonus = await getNumberSetting('referral.bonus_amount', REFERRAL_BONUS_FALLBACK);
  const referralQualifying = await getNumberSetting('referral.qualifying_deposit', REFERRAL_QUALIFY_FALLBACK);

  return prisma.$transaction(async (tx) => {
    const req = await tx.fundRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new ApiError(404, 'Request not found');
    if (req.status !== 'PENDING') throw new ApiError(400, 'Request is not pending');

    // Withdrawals: admin confirms only after paying out manually — evidence is mandatory
    if (req.type === 'WITHDRAWAL') {
      if (!txId) throw new ApiError(400, 'Transaction ID is required to approve a withdrawal');
      if (!proofPath) throw new ApiError(400, 'Completion proof image is required to approve a withdrawal');
    }

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

    // Create Transaction (ledger entry) — amount always positive, same as deposits
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

    // Update request — withdrawals land fully completed (paid + evidenced) in one step
    await tx.fundRequest.update({
      where: { id: requestId },
      data: {
        status: 'APPROVED',
        reviewedById: adminId,
        reviewedAt: new Date(),
        ...(req.type === 'WITHDRAWAL'
          ? { transactionId: txId.slice(0, 100), completionProofImagePath: proofPath, completedAt: new Date() }
          : {}),
      },
    });

    await tx.adminActionLog.create({
      data: {
        userId: adminId,
        action: req.type === 'WITHDRAWAL' ? 'WITHDRAWAL_APPROVED' : 'DEPOSIT_APPROVED',
        targetType: 'FundRequest',
        targetId: requestId,
        metadata: { amount: Number(req.amount), userId: req.userId, ...(req.type === 'WITHDRAWAL' ? { transactionId: txId.slice(0, 100) } : {}) } as never,
      },
    });

    // Referral payout — only on qualifying DEPOSIT approvals.
    // PAUSED (see REFERRAL_BONUS_PAUSED): referrals stay PENDING, nobody is paid.
    // The conditional updateMany (WHERE status='PENDING') is the double-pay guard:
    // only one concurrent approval can win the race and flip the status.
    // Amount + threshold are read live from settings; the credited figure is
    // snapshotted onto the referral row for audit.
    if (!REFERRAL_BONUS_PAUSED && req.type === 'DEPOSIT' && Number(req.amount) >= referralQualifying) {
      const referral = await tx.referral.findFirst({
        where: { refereeId: req.userId, status: 'PENDING' },
        include: { referrer: { select: { id: true, balance: true } } },
      });
      if (referral) {
        const claimed = await tx.referral.updateMany({
          where: { id: referral.id, status: 'PENDING' },
          data: { status: 'REWARDED', bonusAmount: referralBonus, qualifiedAt: new Date(), rewardedAt: new Date() },
        });
        if (claimed.count === 1) {
          const updatedReferrer = await tx.user.update({
            where: { id: referral.referrerId },
            data: { balance: { increment: referralBonus } },
          });
          await tx.transaction.create({
            data: {
              userId: referral.referrerId,
              type: 'REFERRAL_BONUS',
              amount: referralBonus,
              balanceAfter: Number(updatedReferrer.balance),
              reference: `referral:${referral.id}`,
            },
          });
        }
      }
    }

    return { request: req, transaction };
  }, TX_OPTIONS).then(async (out) => {
    await notify({
      audience: 'USER',
      userId: out.request.userId,
      type: out.request.type === 'WITHDRAWAL' ? 'WITHDRAWAL_APPROVED' : 'DEPOSIT_APPROVED',
      title: out.request.type === 'WITHDRAWAL'
        ? `Withdrawal approved — ETB ${Number(out.request.amount).toFixed(2)}`
        : `Deposit approved — ETB ${Number(out.request.amount).toFixed(2)}`,
      linkUrl: '/wallet',
    });
    return out;
  });
}

export async function rejectRequest(requestId: string, adminId: string, reason: string) {
  const cleanReason = (reason ?? '').trim();
  if (!cleanReason) throw new ApiError(400, 'A rejection reason is required');
  return prisma.$transaction(async (tx) => {
    const req = await tx.fundRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new ApiError(404, 'Request not found');
    if (req.status !== 'PENDING') throw new ApiError(400, 'Request is not pending');

    // Release held balance (withdrawals only) — balance itself was never touched
    if (req.type === 'WITHDRAWAL') {
      await tx.user.update({ where: { id: req.userId }, data: { heldBalance: { decrement: req.amount } } });
    }

    await tx.fundRequest.update({
      where: { id: requestId },
      data: { status: 'REJECTED', reviewedById: adminId, reviewedAt: new Date(), rejectionReason: cleanReason },
    });

    await tx.adminActionLog.create({
      data: {
        userId: adminId,
        action: req.type === 'WITHDRAWAL' ? 'WITHDRAWAL_REJECTED' : 'DEPOSIT_REJECTED',
        targetType: 'FundRequest',
        targetId: requestId,
        metadata: { amount: Number(req.amount), userId: req.userId, reason: cleanReason } as never,
      },
    });

    return req;
  }, TX_OPTIONS);
}

export async function completeWithdrawal(requestId: string, adminId: string, data: { transactionId: string; completionProofImagePath?: string }) {
  const req = await prisma.fundRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new ApiError(404, 'Request not found');
  if (req.type !== 'WITHDRAWAL') throw new ApiError(400, 'Only withdrawal requests can be marked completed');
  if (req.status !== 'APPROVED') throw new ApiError(400, 'Request must be approved before it can be marked completed');

  const txId = (data.transactionId ?? '').trim();
  if (!txId) throw new ApiError(400, 'Transaction ID is required to mark a withdrawal completed');

  const include = {
    user: { select: { id: true, email: true, name: true } },
    reviewedBy: { select: { id: true, email: true, name: true } },
  };

  return prisma.$transaction(async (tx) => {
    const updated = await tx.fundRequest.update({
      where: { id: requestId },
      data: {
        transactionId: txId.slice(0, 100),
        completedAt: new Date(),
        reviewedById: adminId,
        ...(data.completionProofImagePath ? { completionProofImagePath: data.completionProofImagePath } : {}),
      },
      include,
    });
    await tx.adminActionLog.create({
      data: {
        userId: adminId,
        action: 'WITHDRAWAL_COMPLETED',
        targetType: 'FundRequest',
        targetId: requestId,
        metadata: {
          amount: Number(req.amount),
          userId: req.userId,
          transactionId: txId.slice(0, 100),
          ...(data.completionProofImagePath ? { completionProof: true } : {}),
        } as never,
      },
    });
    return updated;
  });
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
  // Sub-admins must never see fund requests belonging to staff accounts.
  if (filters.nonStaffOnly === 'true' || filters.nonStaffOnly === true) {
    where.user = { role: { in: NON_STAFF_ROLES } };
  }
  return prisma.fundRequest.findMany({
    where: where as never,
    include: { user: { select: { id: true, email: true, name: true } }, transferAccount: true, reviewedBy: { select: { id: true, email: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getRequestById(requestId: string) {
  const req = await prisma.fundRequest.findUnique({
    where: { id: requestId },
    include: { user: { select: { id: true, email: true, name: true, role: true } }, transferAccount: true, reviewedBy: { select: { id: true, email: true, name: true } }, transaction: true },
  });
  if (!req) throw new ApiError(404, 'Request not found');
  return req;
}

export async function getMyAvailableBalance(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { balance: true, heldBalance: true } });
  if (!user) return { balance: 0, heldBalance: 0, available: 0 };
  return { balance: Number(user.balance), heldBalance: Number(user.heldBalance), available: Number(user.balance) - Number(user.heldBalance) };
}