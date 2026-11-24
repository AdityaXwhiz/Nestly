import { describe, it, expect, vi } from 'vitest';
import {
  computeTargetPerformanceNow,
  getRemainingSeconds,
  formatRemainingTime,
} from '../src/utils/countdown.js';

describe('Precise Hold Countdown (Change #1)', () => {
  it('computes target monotonic timestamp using server_time and hold_expires_at at receipt', () => {
    // 5 minutes (300 seconds) duration on server
    const serverTime = '2026-11-24T12:00:00.000Z';
    const expiresAt = '2026-11-24T12:05:00.000Z';

    const currentPerf = performance.now();
    const targetPerf = computeTargetPerformanceNow(expiresAt, serverTime);

    // Difference between target and current must equal 300,000 ms
    expect(Math.round(targetPerf - currentPerf)).toBe(300000);

    const remainingSec = getRemainingSeconds(targetPerf);
    expect(remainingSec).toBe(300);
    expect(formatRemainingTime(remainingSec)).toBe('5:00');
  });

  it('accurately counts down to zero as performance.now() advances', () => {
    const serverTime = '2026-11-24T12:00:00.000Z';
    const expiresAt = '2026-11-24T12:00:30.000Z'; // 30 seconds

    const initialPerf = performance.now();
    const targetPerf = computeTargetPerformanceNow(expiresAt, serverTime);

    expect(getRemainingSeconds(targetPerf)).toBe(30);
    expect(formatRemainingTime(30)).toBe('0:30');

    // Simulate 20 seconds elapsed
    vi.spyOn(performance, 'now').mockReturnValue(initialPerf + 20000);
    expect(getRemainingSeconds(targetPerf)).toBe(10);
    expect(formatRemainingTime(10)).toBe('0:10');

    // Simulate 35 seconds elapsed (past expiration)
    vi.spyOn(performance, 'now').mockReturnValue(initialPerf + 35000);
    expect(getRemainingSeconds(targetPerf)).toBe(0);
    expect(formatRemainingTime(0)).toBe('0:00');

    vi.restoreAllMocks();
  });

  it('safely handles missing or invalid timestamps without throwing', () => {
    expect(computeTargetPerformanceNow(null, null)).toBeNull();
    expect(computeTargetPerformanceNow('invalid', 'invalid')).toBeNull();
    expect(getRemainingSeconds(null)).toBe(0);
    expect(formatRemainingTime(null)).toBe('0:00');
  });
});
