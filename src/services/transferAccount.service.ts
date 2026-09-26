import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import { z } from 'zod';

export const createTransferAccountSchema = z.object({
  accountType: z.string().max(50).optional().nullable(),
  accountName: z.string().min(1).max(100).optional().nullable(),
  accountNumber: z.string().min(4).max(50),
  bankName: z.string().max(100).optional().nullable(),
  bankCode: z.string().max(20).optional().nullable(),
  branchName: z.string().max(100).optional().nullable(),
  branchCode: z.string().max(20).optional().nullable(),
  swiftCode: z.string().max(20).optional().nullable(),
  status: z.boolean().optional().default(true),
});

export const updateTransferAccountSchema = createTransferAccountSchema.partial();

export type CreateTransferAccountInput = z.infer<typeof createTransferAccountSchema>;
export type UpdateTransferAccountInput = z.infer<typeof updateTransferAccountSchema>;

export const listTransferAccounts = async () => {
  return prisma.ourTransferAccount.findMany({
    orderBy: { createdAt: 'desc' },
  });
};

export const listActiveTransferAccounts = async () => {
  return prisma.ourTransferAccount.findMany({
    where: { status: true },
    orderBy: { createdAt: 'desc' },
  });
};

export const getTransferAccountById = async (id: string) => {
  const account = await prisma.ourTransferAccount.findUnique({ where: { id } });
  if (!account) throw new ApiError(404, 'Transfer account not found');
  return account;
};

export const createTransferAccount = async (data: CreateTransferAccountInput, creatorId: string) => {
  const parsed = createTransferAccountSchema.parse(data);
  // Ensure accountNumber uniqueness at app level (schema doesn't enforce)
  const exists = await prisma.ourTransferAccount.findFirst({ where: { accountNumber: parsed.accountNumber } });
  if (exists) throw new ApiError(409, 'Account number already exists');
  return prisma.$transaction(async (tx) => {
    const created = await tx.ourTransferAccount.create({ data: { ...parsed, createdById: creatorId } as never });
    await tx.adminActionLog.create({
      data: {
        userId: creatorId,
        action: 'TRANSFER_ACCOUNT_CREATED',
        targetType: 'OurTransferAccount',
        targetId: created.id,
        metadata: {
          accountType: created.accountType,
          bankName: created.bankName,
          accountName: created.accountName,
          accountNumber: created.accountNumber,
        } as never,
      },
    });
    return created;
  });
};

export const updateTransferAccount = async (id: string, data: UpdateTransferAccountInput, actorId: string) => {
  const before = await getTransferAccountById(id);
  const parsed = updateTransferAccountSchema.parse(data);
  if (parsed.accountNumber) {
    const dup = await prisma.ourTransferAccount.findFirst({
      where: { accountNumber: parsed.accountNumber, NOT: { id } },
    });
    if (dup) throw new ApiError(409, 'Account number already exists');
  }
  const changedKeys = (Object.keys(parsed) as (keyof UpdateTransferAccountInput)[]).filter(
    (k) => (parsed[k] as unknown) !== (before[k as keyof typeof before] as unknown)
  );
  return prisma.$transaction(async (tx) => {
    const updated = await tx.ourTransferAccount.update({ where: { id }, data: parsed as never });
    await tx.adminActionLog.create({
      data: {
        userId: actorId,
        action: 'TRANSFER_ACCOUNT_UPDATED',
        targetType: 'OurTransferAccount',
        targetId: id,
        metadata: {
          changed: changedKeys,
          before: Object.fromEntries(changedKeys.map((k) => [k, before[k as keyof typeof before] ?? null])),
          after: Object.fromEntries(changedKeys.map((k) => [k, parsed[k] ?? null])),
        } as never,
      },
    });
    return updated;
  });
};

export const deleteTransferAccount = async (id: string, actorId: string) => {
  const before = await getTransferAccountById(id);
  return prisma.$transaction(async (tx) => {
    const deleted = await tx.ourTransferAccount.delete({ where: { id } });
    await tx.adminActionLog.create({
      data: {
        userId: actorId,
        action: 'TRANSFER_ACCOUNT_DELETED',
        targetType: 'OurTransferAccount',
        targetId: id,
        metadata: {
          accountType: before.accountType,
          bankName: before.bankName,
          accountName: before.accountName,
          accountNumber: before.accountNumber,
        } as never,
      },
    });
    return deleted;
  });
};
