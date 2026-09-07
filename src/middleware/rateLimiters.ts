import rateLimit from 'express-rate-limit';

const WINDOW_MS = 15 * 60 * 1000;

// Strict — login, register, 2FA, token refresh only.
// Everything else is unlimited: with the same-origin proxy architecture all
// users share the VPS IP, so per-IP limits would throttle the whole site.
export const authLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ status: 429, message: 'Too many authentication attempts. Please try again in 15 minutes.' });
  },
});

export const betLimiter = (req: unknown, res: unknown, next: () => void) => next();
export const generalLimiter = (req: unknown, res: unknown, next: () => void) => next();
