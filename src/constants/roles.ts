import { Role as PrismaRole } from '@prisma/client';

/**
 * The sub-admin role has two spellings in this codebase:
 *  - `SUB_ADMIN` is the member declared in prisma/schema.prisma (and therefore the
 *    value stored in the database enum).
 *  - `SUBADMIN` is the spelling used by the API contract / frontend.
 *
 * The database is the source of truth for what is actually persisted, so we read
 * the value from the generated Prisma client instead of hard-coding it. This
 * keeps authorisation and role updates working regardless of which spelling the
 * live database enum uses, and lets the schema be normalised to either one.
 */
export const SUBADMIN_ROLE_VALUES = ['SUBADMIN', 'SUB_ADMIN'] as const;

const prismaRoleValues = PrismaRole as unknown as Record<string, string>;

/** The value actually accepted by the database `Role` enum. */
export const SUBADMIN_ROLE: string = prismaRoleValues.SUBADMIN ?? prismaRoleValues.SUB_ADMIN ?? 'SUB_ADMIN';

export const isSubAdminRole = (role?: string | null): boolean =>
  !!role && (SUBADMIN_ROLE_VALUES as readonly string[]).includes(role);

/** Map any accepted sub-admin spelling onto the value the database expects. */
export const normalizeRole = (role: string): string => (isSubAdminRole(role) ? SUBADMIN_ROLE : role);

const REVIEWER_ROLES = new Set(['ADMIN', 'ODDS_MANAGER', ...SUBADMIN_ROLE_VALUES]);

/**
 * True for roles allowed to review operational data such as fund-request proof
 * images. Accepts both sub-admin spellings; comparing against a literal
 * `'SUBADMIN'` array would silently reject accounts persisted as `SUB_ADMIN`.
 */
export const isReviewerRole = (role?: string | null): boolean => !!role && REVIEWER_ROLES.has(role);
