import crypto from 'node:crypto';
import { redis, isRedisAvailable } from '../redis.js';
import { acquire, release } from './lock.js';

/**
 * Cache consistency and staleness semantics:
 * - Search/list results accept bounded staleness of up to 30 seconds (TTL-only).
 *   Mutations do not aggressively bust list caches because combinatorial search filters
 *   and pagination make fan-out invalidation impractical and expensive.
 * - Entity detail caches (property/service) use cache-aside with explicit deletion on update.
 *   The potential "delete-vs-refill" race (where an in-flight read populates the cache
 *   with stale data right after an update deleted the key) is safely bounded by the short
 *   TTL (minutes with random jitter).
 * - Availability, holds, and reservation decisions are NEVER cached; checkout and holds
 *   always validate against PostgreSQL.
 */

function logCacheEvent(outcome, key) {
  // Silent in production/test unless LOG_LEVEL=debug; avoids polluting stdout
}

/**
 * Get an item from Redis. Returns null on miss, error, or if Redis is down.
 */
export async function get(key) {
  if (!isRedisAvailable()) return null;
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Set an item in Redis with jittered TTL.
 * Never caches not-found results (null/undefined) or non-ACTIVE records.
 */
export async function set(key, value, ttlSec, jitterSec = 0) {
  if (!isRedisAvailable() || value == null) return;

  // Never cache non-active entities
  if (value.status && value.status !== 'ACTIVE') return;

  try {
    const jitter = jitterSec > 0 ? Math.floor(Math.random() * jitterSec) : 0;
    const effectiveTtl = Math.max(1, ttlSec + jitter);
    await redis.set(key, JSON.stringify(value), 'EX', effectiveTtl);
  } catch {
    // Fail-open: ignore Redis write error
  }
}

/**
 * Delete a cache key explicitly upon mutation.
 */
export async function del(key) {
  if (!isRedisAvailable()) return;
  try {
    await redis.del(key);
  } catch {
    // Fail-open
  }
}

/**
 * Cache-aside with stampede protection (single-flight mutex).
 * Losers retry the cache a fixed small number of times before falling back to PostgreSQL.
 *
 * @param {string} key - Cache key
 * @param {number} ttlSec - TTL in seconds
 * @param {() => Promise<any>} fetchFn - Database fallback query
 * @param {Object} [options]
 * @param {number} [options.jitterSec=30] - Max random jitter to add to TTL
 * @param {number} [options.maxRetries=3] - Number of times stampede losers retry cache
 * @param {number} [options.retryDelayMs=40] - Delay between retries
 * @returns {Promise<any>}
 */
export async function remember(key, ttlSec, fetchFn, options = {}) {
  // 1. Try reading from cache
  const cached = await get(key);
  if (cached != null) {
    logCacheEvent('hit', key);
    return cached;
  }
  logCacheEvent('miss', key);

  if (!isRedisAvailable()) {
    logCacheEvent('bypass', key);
    return fetchFn();
  }

  // 2. Cache miss: attempt stampede lock
  const lockKey = `lock:cache:${key}`;
  const lock = await acquire(lockKey, 2000);

  if (lock.status === 'acquired') {
    try {
      const data = await fetchFn();
      if (data != null) {
        // Enforce active-only rule: if entity has status, cache only if ACTIVE
        const shouldCache =
          !data.status ||
          data.status === 'ACTIVE' ||
          (Array.isArray(data.properties) || Array.isArray(data.services));

        if (shouldCache) {
          await set(key, data, ttlSec, options.jitterSec || 30);
          logCacheEvent('write', key);
        }
      }
      return data;
    } finally {
      await release(lockKey, lock.token);
    }
  }

  if (lock.status === 'busy') {
    // Stampede loser: retry reading cache a fixed number of times
    const maxRetries = options.maxRetries || 3;
    const retryDelayMs = options.retryDelayMs || 40;

    for (let i = 0; i < maxRetries; i++) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      const reRead = await get(key);
      if (reRead != null) {
        logCacheEvent('hit', key);
        return reRead;
      }
    }

    // Still missing after retries: fall back to database
    logCacheEvent('fallback', key);
    return fetchFn();
  }

  // If lock is unavailable (Redis blip), query DB directly
  logCacheEvent('bypass', key);
  return fetchFn();
}

/**
 * Generate a deterministic sha256 search cache key from query params.
 * Normalizes defaults, sorts parameters, and includes limit and page.
 */
export function generateSearchCacheKey(prefix, query = {}) {
  const normalized = {
    page: Number(query.page) || 1,
    limit: Math.min(Number(query.limit) || 20, 50),
  };

  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '' && k !== 'page' && k !== 'limit') {
      normalized[k] = typeof v === 'string' ? v.trim().toLowerCase() : v;
    }
  }

  const sortedKeys = Object.keys(normalized).sort();
  const canonicalString = sortedKeys.map((k) => `${k}=${normalized[k]}`).join('&');
  const hash = crypto.createHash('sha256').update(canonicalString).digest('hex').slice(0, 32);

  return `cache:search:${prefix}:${hash}`;
}
