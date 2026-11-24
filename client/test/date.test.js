import { describe, it, expect } from 'vitest';
import {
  getUserTimeZone,
  formatDate,
  formatDateTime,
  formatDateRange,
  toInputDateFormat,
  toIsoWithLocalOffset,
} from '../src/utils/date.js';

describe('date utils (Change #8)', () => {
  it('getUserTimeZone returns viewer local time zone string', () => {
    const tz = getUserTimeZone();
    expect(typeof tz).toBe('string');
    expect(tz.length).toBeGreaterThan(0);
  });

  it('formatDate formats ISO dates and returns "—" for invalid inputs', () => {
    expect(formatDate('2026-11-25T10:00:00.000Z')).toMatch(/25\sNov\s2026/);
    expect(formatDate('')).toBe('—');
    expect(formatDate(null)).toBe('—');
    expect(formatDate('invalid-date')).toBe('—');
  });

  it('formatDateTime includes local timezone indicator', () => {
    const formatted = formatDateTime('2026-11-25T10:00:00.000Z');
    expect(formatted).toContain(getUserTimeZone());
  });

  it('formatDateRange formats a pair of dates', () => {
    const range = formatDateRange('2026-11-25T00:00:00.000Z', '2026-11-28T00:00:00.000Z');
    expect(range).toMatch(/25\sNov\s2026\s–\s28\sNov\s2026/);
    expect(formatDateRange(null, '2026-11-28T00:00:00.000Z')).toBe('—');
  });

  it('toInputDateFormat outputs YYYY-MM-DD format for HTML5 date input', () => {
    const d = new Date(2026, 10, 25); // Month is 0-indexed (10 = November)
    expect(toInputDateFormat(d)).toBe('2026-11-25');
    expect(toInputDateFormat(null)).toBe('');
  });

  it('toIsoWithLocalOffset converts date input string to ISO timestamp with local offset', () => {
    const startIso = toIsoWithLocalOffset('2026-11-25', false);
    const endIso = toIsoWithLocalOffset('2026-11-25', true);

    expect(startIso).toBeTruthy();
    expect(endIso).toBeTruthy();

    const startDate = new Date(startIso);
    const endDate = new Date(endIso);

    expect(startDate.getFullYear()).toBe(2026);
    expect(startDate.getMonth()).toBe(10);
    expect(startDate.getDate()).toBe(25);
    expect(endDate > startDate).toBe(true);
  });
});
