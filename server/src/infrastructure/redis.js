import Redis from 'ioredis';
import { env } from '../config/env.js';

let redisDisabledForTesting = false;

export const redis = new Redis(env.REDIS_URL, {
  connectTimeout: 2000,
  commandTimeout: 1500,
  maxRetriesPerRequest: 1,
  lazyConnect: true,
  retryStrategy: (times) => {
    // Reconnect with bounded backoff up to 2 seconds so recovery is automatic
    return Math.min(times * 100, 2000);
  },
});

// Suppress unhandled error events so an unreachable Redis does not crash the Node process
redis.on('error', () => {});

/**
 * Toggle Redis availability for testing.
 * Strictly permitted only when NODE_ENV === 'test'.
 */
export function setRedisDisabledForTesting(disabled) {
  if (process.env.NODE_ENV === 'test') {
    redisDisabledForTesting = Boolean(disabled);
  }
}

/**
 * Decides whether Redis can be safely used.
 */
export function isRedisAvailable() {
  if (redisDisabledForTesting) {
    return false;
  }
  return ['ready', 'connect', 'connecting', 'wait'].includes(redis.status);
}

/**
 * Quick connectivity check — sends a PING.
 * Resolves true if Redis is reachable, false otherwise.
 */
export async function pingRedis() {
  if (redisDisabledForTesting) {
    return false;
  }
  try {
    const reply = await redis.ping();
    return reply === 'PONG';
  } catch {
    return false;
  }
}
