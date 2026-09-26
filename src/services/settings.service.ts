import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';

type SettingKind = 'number' | 'string' | 'boolean';

type SettingDef = {
  kind: SettingKind;
  label: string;
  description: string;
  min?: number;
  max?: number;
  /** Section heading in the admin settings page. */
  group: string;
  /** Unit hint shown next to the value input (e.g. ETB, minutes). */
  unit?: string;
  /**
   * Value used when no row exists yet. Reported to the admin UI so a setting
   * that has never been saved still shows what is actually in effect.
   */
  defaultValue?: number | boolean | null;
};

/**
 * Registry of known settings. To add a future setting, add one entry here
 * (key + kind + label) — no migration needed, rows are created on first save.
 */
export const KNOWN_SETTINGS: Record<string, SettingDef> = {
  'referral.bonus_amount': {
    kind: 'number',
    label: 'Referral bonus amount (ETB)',
    description: 'Paid to the referrer when a referred user makes a qualifying deposit.',
    min: 0,
    group: 'Referral',
    unit: 'ETB',
  },
  'referral.qualifying_deposit': {
    kind: 'number',
    label: 'Qualifying deposit (ETB)',
    description: 'Minimum first deposit a referred user must make for the referrer to earn the bonus.',
    min: 0,
    group: 'Referral',
    unit: 'ETB',
  },
  'betting.max_stake': {
    kind: 'number',
    label: 'Maximum stake per bet (ETB)',
    description: 'Largest single stake a user may place. Empty/unset means no limit.',
    min: 1,
    group: 'Betting',
    unit: 'ETB',
  },
  'betting.min_stake': {
    kind: 'number',
    label: 'Minimum stake per ticket (ETB)',
    description: 'Smallest stake a user may place on one ticket. Tickets below this are rejected. Empty/unset falls back to 10.',
    min: 1,
    group: 'Betting',
    unit: 'ETB',
    defaultValue: 10,
  },
  'deposit.min_amount': {
    kind: 'number',
    label: 'Minimum deposit (ETB)',
    description: 'Smallest deposit a user may request. Empty/unset falls back to 100.',
    min: 1,
    group: 'Deposit',
    unit: 'ETB',
    defaultValue: 100,
  },
  'betting.max_legs': {
    kind: 'number',
    label: 'Maximum markets per ticket',
    description: 'Most selections a single bet slip may contain. Empty/unset falls back to 30.',
    min: 1,
    group: 'Betting',
    defaultValue: 30,
  },
  'betting.max_payout': {
    kind: 'number',
    label: 'Maximum ticket payout (ETB)',
    description: 'Tickets whose potential payout exceeds this are rejected at placement. Empty/unset means no limit.',
    min: 1,
    group: 'Betting',
    unit: 'ETB',
  },
  'registration.require_agent': {
    kind: 'boolean',
    label: 'Require an agent to register',
    description: 'When ON, users cannot self-register: signup only succeeds if an agent is detected (agent second code or an agent referral link). When OFF, anyone can register.',
    group: 'Registration',
    defaultValue: false,
  },
  'auth.lockout_enabled': {
    kind: 'boolean',
    label: 'Block sign-in after too many failed attempts',
    description: 'When ON, repeated failed sign-in attempts from one client are blocked with a "too many authentication attempts" error until the retry delay passes. When OFF, that error is never returned and sign-in is never blocked for this reason.',
    group: 'Authentication',
    defaultValue: true,
  },
  'auth.lockout_minutes': {
    kind: 'number',
    label: 'Retry delay after too many attempts (minutes)',
    description: 'How long a blocked client must wait before it can sign in again. Takes effect as soon as you save, and applies while blocking is ON.',
    min: 1,
    max: 1440,
    group: 'Authentication',
    unit: 'minutes',
    defaultValue: 15,
  },
};

export type SettingValue = { valueNumber?: number | null; valueString?: string | null; valueBool?: boolean | null };

function pickValue(def: SettingDef, v: SettingValue) {
  if (def.kind === 'number') {
    if (v.valueNumber === undefined || v.valueNumber === null || typeof v.valueNumber !== 'number' || Number.isNaN(v.valueNumber)) {
      throw new ApiError(400, `${def.label} must be a number`);
    }
    if (def.min !== undefined && v.valueNumber < def.min) throw new ApiError(400, `${def.label} must be at least ${def.min}`);
    if (def.max !== undefined && v.valueNumber > def.max) throw new ApiError(400, `${def.label} must be at most ${def.max}`);
    return { valueNumber: v.valueNumber, valueString: null, valueBool: null };
  }
  if (def.kind === 'string') {
    if (typeof v.valueString !== 'string') throw new ApiError(400, `${def.label} must be text`);
    return { valueNumber: null, valueString: v.valueString.slice(0, 191), valueBool: null };
  }
  if (typeof v.valueBool !== 'boolean') throw new ApiError(400, `${def.label} must be true or false`);
  return { valueNumber: null, valueString: null, valueBool: v.valueBool };
}

export async function listSettings() {
  const rows = await prisma.appSetting.findMany({ include: { updatedBy: { select: { id: true, email: true, name: true } } } });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return Object.entries(KNOWN_SETTINGS).map(([key, def]) => {
    const row = byKey.get(key);
    return {
      key,
      label: def.label,
      description: def.description,
      kind: def.kind,
      group: def.group,
      unit: def.unit ?? null,
      defaultValue: def.defaultValue ?? null,
      valueNumber: row?.valueNumber != null ? Number(row.valueNumber) : null,
      valueString: row?.valueString ?? null,
      valueBool: row?.valueBool ?? null,
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

export async function getNumberSetting(key: string, fallback: number): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  const v = row?.valueNumber;
  return v != null ? Number(v) : fallback;
}

export async function getBoolSetting(key: string, fallback = false): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  if (row?.valueBool == null) return fallback;
  return row.valueBool;
}

export async function setSetting(key: string, value: SettingValue, adminId: string) {
  const def = KNOWN_SETTINGS[key];
  if (!def) throw new ApiError(400, `Unknown setting: ${key}`);
  const data = pickValue(def, value);
  const row = await prisma.appSetting.upsert({
    where: { key },
    create: { key, ...data, updatedById: adminId },
    update: { ...data, updatedById: adminId },
    include: { updatedBy: { select: { id: true, email: true, name: true } } },
  });
  await prisma.adminActionLog.create({
    data: {
      userId: adminId,
      action: 'SETTING_UPDATED',
      targetType: 'AppSetting',
      targetId: key,
      metadata: { key, ...data } as never,
    },
  });
  return row;
}
