import Redis from 'ioredis';
import { env } from '../config/env.js';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 1,   // fail fast for health checks
  lazyConnect: true,          // don't connect until first command
});

/**
 * Quick connectivity check — sends a PING.
 * Resolves true if Redis is reachable, false otherwise.
 */
export async function pingRedis() {
  try {
    const reply = await redis.ping();
    return reply === 'PONG';
  } catch {
    return false;
  }
}
