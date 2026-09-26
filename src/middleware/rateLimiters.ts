import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import { getBoolSetting, getNumberSetting } from '../services/settings.service';

const DEFAULT_WINDOW_MINUTES = 15;
// Attempts allowed per client inside the window. Kept constant: only the retry
// delay and the on/off switch are admin-configurable.
const MAX_ATTEMPTS = 8;
// Settings are read from the database, so the resolved config is memoised for a
// short while to avoid a query on every single sign-in attempt.
const CONFIG_TTL_MS = 15_000;

type AuthLimiterConfig = {
  /** When false the "too many authentication attempts" error is never produced. */
  enabled: boolean;
  windowMinutes: number;
  maxAttempts: number;
};

let cache: { config: AuthLimiterConfig; handler: RateLimitRequestHandler } | null = null;
let cacheExpiresAt = 0;
let inflight: Promise<void> | null = null;

const readConfig = async (): Promise<AuthLimiterConfig> => {
  const [enabled, windowMinutes] = await Promise.all([
    getBoolSetting('auth.lockout_enabled', true),
    getNumberSetting('auth.lockout_minutes', DEFAULT_WINDOW_MINUTES),
  ]);
  return {
    enabled,
    windowMinutes: Math.min(1440, Math.max(1, Math.round(windowMinutes))),
    maxAttempts: MAX_ATTEMPTS,
  };
};

const sameConfig = (a: AuthLimiterConfig, b: AuthLimiterConfig) =>
  a.enabled === b.enabled && a.windowMinutes === b.windowMinutes && a.maxAttempts === b.maxAttempts;

const buildLimiter = (config: AuthLimiterConfig): RateLimitRequestHandler =>
  rateLimit({
    windowMs: config.windowMinutes * 60 * 1000,
    limit: config.maxAttempts,
    standardHeaders: true,
    legacyHeaders: false,
    // The token refresh endpoint is exempt: every client needs it regularly,
    // and 429-ing it logs users out.
    skip: (req) => req.path === '/refresh',
    handler: (_req, res) => {
      res.status(429).json({
        status: 429,
        message: `Too many authentication attempts. Please try again in ${config.windowMinutes} minute${
          config.windowMinutes === 1 ? '' : 's'
        }.`,
      });
    },
  });

/**
 * Resolve the limiter for the currently configured window. A changed setting
 * builds a fresh limiter, which also clears the in-memory attempt counters.
 */
const resolveLimiter = async (): Promise<{ config: AuthLimiterConfig; handler: RateLimitRequestHandler }> => {
  if (cache && Date.now() < cacheExpiresAt) return cache;
  if (!inflight) {
    inflight = (async () => {
      const config = await readConfig();
      if (!cache || !sameConfig(cache.config, config)) {
        cache = { config, handler: buildLimiter(config) };
      }
      cacheExpiresAt = Date.now() + CONFIG_TTL_MS;
    })().finally(() => {
      inflight = null;
    });
  }
  await inflight;
  // readConfig can only produce a config, so this is always populated by now.
  return cache!;
};

/** Called after an auth setting is saved so the change applies on the next request. */
export const invalidateAuthLimiterCache = () => {
  cache = null;
  cacheExpiresAt = 0;
};

/**
 * Strict — login, register, 2FA. Behaviour is driven by the Authentication
 * settings in the admin panel: when lockout is turned off this simply calls
 * next(), so no "too many authentication attempts" error can be produced.
 */
export const authLimiter = async (req: unknown, res: unknown, next: () => void) => {
  try {
    const { config, handler } = await resolveLimiter();
    if (!config.enabled) {
      next();
      return;
    }
    (handler as RateLimitRequestHandler)(req as never, res as never, next as never);
  } catch {
    // Never block authentication because a settings read failed.
    next();
  }
};

export const betLimiter = (req: unknown, res: unknown, next: () => void) => next();
export const generalLimiter = (req: unknown, res: unknown, next: () => void) => next();
