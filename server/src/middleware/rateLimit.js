import { redis } from '../infrastructure/redis.js';
import { env } from '../config/env.js';
import { AppError } from '../errors/AppError.js';

/**
 * Redis counter-based rate limiting middleware.
 * Uses the Redis key pattern: rate:{scope}:{window} (scoped by client IP).
 * Fails open if Redis is unreachable (per HLD / LLD resilience rules).
 *
 * @param {Object} options
 * @param {string} [options.scope='auth'] - Scope descriptor
 * @param {number} [options.max] - Max requests permitted in the window
 * @param {number} [options.windowSec] - Window duration in seconds
 */
export function rateLimit(options = {}) {
  const scope = options.scope || 'auth';
  const defaultMax = env.NODE_ENV === 'test' ? 1000 : env.RATE_LIMIT_AUTH_MAX;
  const max = options.max !== undefined ? options.max : defaultMax;
  const windowSec = options.windowSec || env.RATE_LIMIT_AUTH_WINDOW_SEC;

  return async (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const currentEpochSec = Math.floor(Date.now() / 1000);
    const window = Math.floor(currentEpochSec / windowSec);
    const key = `rate:${scope}:${ip}:${window}`;

    try {
      const count = await redis.incr(key);
      if (count === 1) {
        // Set TTL to cover the current window plus grace period
        await redis.expire(key, windowSec * 2);
      }

      if (count > max) {
        const secondsUntilReset = Math.max(1, windowSec - (currentEpochSec % windowSec));
        res.setHeader('Retry-After', String(secondsUntilReset));
        return next(
          new AppError('RATE_LIMITED', 429, 'Too many requests, please try again later'),
        );
      }
    } catch (err) {
      // Fail-open: Redis outage should never break public traffic
      if (req.log) {
        req.log.warn({ err: err.message, key }, 'Redis rate limiter error, failing open');
      }
    }

    next();
  };
}
