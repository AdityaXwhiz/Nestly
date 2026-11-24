/**
 * Precise hold countdown utility (Change #1).
 * Computes remaining hold time from server_time and hold_expires_at at receipt,
 * then counts down with performance.now().
 * Does not read the HTTP Date header or rely on local device clock accuracy.
 */

/**
 * Compute the target monotonic timestamp using performance.now().
 * @param {string} holdExpiresAtIso - ISO timestamp of hold expiration
 * @param {string} serverTimeIso - ISO timestamp of server time when response was generated
 * @returns {number|null} target monotonic timestamp in milliseconds
 */
export function computeTargetPerformanceNow(holdExpiresAtIso, serverTimeIso) {
  if (!holdExpiresAtIso || !serverTimeIso) return null;
  const expiresMs = new Date(holdExpiresAtIso).getTime();
  const serverMs = new Date(serverTimeIso).getTime();
  if (Number.isNaN(expiresMs) || Number.isNaN(serverMs)) return null;

  const remainingDurationMs = Math.max(0, expiresMs - serverMs);
  return performance.now() + remainingDurationMs;
}

/**
 * Get remaining integer seconds until expiration based on target performance.now().
 * @param {number|null} targetPerformanceNow
 * @returns {number}
 */
export function getRemainingSeconds(targetPerformanceNow) {
  if (targetPerformanceNow == null) return 0;
  const remainingMs = targetPerformanceNow - performance.now();
  return Math.max(0, Math.round(remainingMs / 1000));
}

/**
 * Format remaining seconds into MM:SS.
 * @param {number} seconds
 * @returns {string}
 */
export function formatRemainingTime(seconds) {
  const safeSec = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(safeSec / 60);
  const s = safeSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
