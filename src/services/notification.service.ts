import prisma from '../utils/prisma';

export type NotifyAudience = 'USER' | 'ADMIN';

export type NotifyInput = {
  audience: NotifyAudience;
  /** recipient for USER; subject user for ADMIN (null for game events) */
  userId?: string | null;
  type: string;
  title: string;
  message?: string;
  linkUrl?: string;
};

/**
 * Fire-and-forget notification writer. Never throws — a notification must
 * never break signup, money movement or cron runs. Failures are logged.
 */
export async function notify(input: NotifyInput): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        audience: input.audience as never,
        userId: input.userId ?? null,
        type: input.type,
        title: input.title.slice(0, 191),
        message: input.message?.slice(0, 191) ?? null,
        linkUrl: input.linkUrl?.slice(0, 191) ?? null,
      },
    });
  } catch (e) {
    console.error('[notify] failed:', e instanceof Error ? e.message : String(e));
  }
}

const includeUser = { user: { select: { id: true, email: true, name: true } } };

export async function listUserNotifications(userId: string, opts?: { unreadOnly?: boolean; limit?: number }) {
  return prisma.notification.findMany({
    where: { audience: 'USER' as never, userId, ...(opts?.unreadOnly ? { isRead: false } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(opts?.limit ?? 50, 1), 200),
  });
}

export async function listAdminNotifications(opts?: { unreadOnly?: boolean; limit?: number }) {
  return prisma.notification.findMany({
    where: { audience: 'ADMIN' as never, ...(opts?.unreadOnly ? { isRead: false } : {}) },
    include: includeUser,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(opts?.limit ?? 50, 1), 200),
  });
}

export async function unreadCounts(userId: string, isAdmin: boolean) {
  const user = await prisma.notification.count({ where: { audience: 'USER' as never, userId, isRead: false } });
  if (!isAdmin) return { user, admin: 0 };
  const admin = await prisma.notification.count({ where: { audience: 'ADMIN' as never, isRead: false } });
  return { user, admin };
}

export async function markRead(notificationId: string, scope: { userId?: string; admin?: boolean }) {
  const n = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!n) return null;
  if (n.audience === 'USER' && n.userId !== scope.userId) return null;
  if (n.audience === 'ADMIN' && !scope.admin) return null;
  return prisma.notification.update({ where: { id: notificationId }, data: { isRead: true } });
}

export async function markAllRead(scope: { userId: string; admin: boolean; adminOnly?: boolean }) {
  if (scope.adminOnly) {
    if (!scope.admin) return { count: 0 };
    return prisma.notification.updateMany({ where: { audience: 'ADMIN' as never, isRead: false }, data: { isRead: true } });
  }
  return prisma.notification.updateMany({
    where: { audience: 'USER' as never, userId: scope.userId, isRead: false },
    data: { isRead: true },
  });
}
