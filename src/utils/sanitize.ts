import type { User } from '@prisma/client';

export const sanitizeUser = <T extends { passwordHash?: string | null }>(
  user: T | null | undefined
): Omit<T, 'passwordHash'> | T | null | undefined => {
  if (!user) return user as T | null | undefined;
  const { passwordHash: _passwordHash, ...rest } = user as T & { passwordHash: string };
  return rest as Omit<T, 'passwordHash'>;
};

export default sanitizeUser;
