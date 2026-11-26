import { SharedArray } from 'k6/data';

const FIXTURES_PATH = __ENV.FIXTURES_PATH || '/results/fixtures.json';

export const fixtures = new SharedArray('nestly-fixtures', () => {
  return [JSON.parse(open(FIXTURES_PATH))];
})[0];

export const API_BASE = (__ENV.API_BASE || 'http://client:8080/api/v1').replace(/\/+$/, '');
export const MOCK_PROVIDER_URL = (__ENV.MOCK_PROVIDER_URL || 'http://mock-provider:3001').replace(/\/+$/, '');

export function authHeaders(token, extra = {}) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

export function pickCustomer(index) {
  const list = fixtures.customers;
  return list[index % list.length];
}

/**
 * Deterministic skewed picker (Change #2):
 * 75% hot slice (first 20% of items / hot pool), 25% cold tail.
 */
export function pickSkewed(arr, hotSliceCount = 100) {
  if (!arr || arr.length === 0) return null;
  const split = Math.min(hotSliceCount, arr.length);
  if (Math.random() < 0.75) {
    return arr[Math.floor(Math.random() * split)];
  }
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate disjoint ISO start/end timestamps from an integer slot index so
 * non-contention booking scenarios never falsely collide on dates.
 */
export function buildDisjointDates(slotIndex, baseDaysAhead = 45) {
  const startDayOffset = baseDaysAhead + slotIndex * 3;
  const baseMs = Date.UTC(2027, 0, 1, 0, 0, 0) + startDayOffset * 24 * 60 * 60 * 1000;
  const start = new Date(baseMs).toISOString();
  const end = new Date(baseMs + 2 * 24 * 60 * 60 * 1000).toISOString();
  const slotDate = start.slice(0, 10);
  return { start, end, slotDate };
}
