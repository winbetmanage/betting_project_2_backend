import * as settingsService from '../services/settings.service';
import { invalidateAuthLimiterCache } from '../middleware/rateLimiters';
import asyncHandler from '../utils/asyncHandler';

export const list = asyncHandler(async (_req, res) => {
  const data = await settingsService.listSettings();
  res.json({ data });
});

export const update = asyncHandler(async (req, res) => {
  const { valueNumber, valueString, valueBool } = req.body as {
    valueNumber?: unknown;
    valueString?: unknown;
    valueBool?: unknown;
  };
  const data = await settingsService.setSetting(
    req.params.key as string,
    {
      valueNumber: valueNumber === undefined ? undefined : Number(valueNumber),
      valueString: valueString === undefined ? undefined : String(valueString),
      valueBool: valueBool === undefined ? undefined : Boolean(valueBool),
    },
    req.user!.id
  );
  // Auth settings drive the rate limiter, so drop its cached config immediately.
  if ((req.params.key as string).startsWith('auth.')) invalidateAuthLimiterCache();
  res.json({ message: 'Setting saved', data });
});

/** Non-sensitive limits for the user side (any authenticated user). */
export const maxStake = asyncHandler(async (_req, res) => {
  const value = await settingsService.getNumberSetting('betting.max_stake', Number.POSITIVE_INFINITY);
  res.json({ data: { maxStake: Number.isFinite(value) ? value : null } });
});

/** All user-facing limits in one call (any authenticated user). */
export const publicLimits = asyncHandler(async (_req, res) => {
  const [maxStake, minDeposit, maxLegs, maxPayout, minStake] = await Promise.all([
    settingsService.getNumberSetting('betting.max_stake', Number.POSITIVE_INFINITY),
    settingsService.getNumberSetting('deposit.min_amount', 100),
    settingsService.getNumberSetting('betting.max_legs', 30),
    settingsService.getNumberSetting('betting.max_payout', Number.POSITIVE_INFINITY),
    settingsService.getNumberSetting('betting.min_stake', 10),
  ]);
  res.json({
    data: {
      maxStake: Number.isFinite(maxStake) ? maxStake : null,
      minDeposit,
      maxLegs,
      maxPayout: Number.isFinite(maxPayout) ? maxPayout : null,
      minStake,
    },
  });
});

/** Public signup info (no auth): whether registration requires an agent. */
export const signupInfo = asyncHandler(async (_req, res) => {
  const requireAgent = await settingsService.getBoolSetting('registration.require_agent', false);
  res.json({ data: { requireAgent } });
});
