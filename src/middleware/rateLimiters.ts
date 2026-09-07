import rateLimit from 'express-rate-limit';

const WINDOW_MS = 15 * 60 * 1000;

// Strict — login, register, 2FA only. The token refresh endpoint is exempt:
// every client needs it regularly, and 429-ing it logs users out.
export const authLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/refresh',
  handler: (_req, res) => {
    res.status(429).json({ status: 429, message: 'Too many authentication attempts. Please try again in 15 minutes.' });
  },
});

export const betLimiter = (req: unknown, res: unknown, next: () => void) => next();
export const generalLimiter = (req: unknown, res: unknown, next: () => void) => next();
