import crypto from 'node:crypto';
import { redis, isRedisAvailable } from '../redis.js';

const RELEASE_LUA = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  else
    return 0
  end
`;

/**
 * Acquire a distributed lock with a random token and TTL.
 *
 * @param {string} key - Lock identifier
 * @param {number} [ttlMs=5000] - Lock TTL in milliseconds
 * @returns {Promise<{ status: 'acquired', token: string } | { status: 'busy' } | { status: 'unavailable' }>}
 */
export async function acquire(key, ttlMs = 5000) {
  if (!isRedisAvailable()) {
    return { status: 'unavailable' };
  }

  try {
    const token = crypto.randomUUID();
    const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
    return ok ? { status: 'acquired', token } : { status: 'busy' };
  } catch {
    return { status: 'unavailable' };
  }
}

/**
 * Release a distributed lock atomically using compare-and-delete.
 * Only deletes the key if the current value matches the caller's token.
 *
 * @param {string} key - Lock identifier
 * @param {string} token - Token returned by acquire()
 * @returns {Promise<number>} - 1 if deleted, 0 if token mismatched or key expired
 */
export async function release(key, token) {
  if (!isRedisAvailable() || !token) {
    return 0;
  }

  try {
    const res = await redis.eval(RELEASE_LUA, 1, key, token);
    return Number(res) || 0;
  } catch {
    return 0;
  }
}
