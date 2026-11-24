import { describe, it, expect, vi } from 'vitest';
import { formatMoney } from '../src/utils/money.js';

describe('formatMoney (Change #4)', () => {
  it('formats non-negative integer minor units to INR currency', () => {
    // ₹0
    expect(formatMoney(0)).toMatch(/₹\s?0/);
    // ₹1,500
    expect(formatMoney(150000)).toMatch(/₹\s?1,500/);
    // ₹99,999
    expect(formatMoney(9999900)).toMatch(/₹\s?99,999/);
  });

  it('formats with decimals when showDecimals is true or when amount has non-zero paise', () => {
    expect(formatMoney(150050)).toMatch(/₹\s?1,500\.50/);
    expect(formatMoney(100000, { showDecimals: true })).toMatch(/₹\s?1,000\.00/);
  });

  it('validates with Number.isSafeInteger and returns "—" without throwing on invalid input', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Float paise (forbidden)
    expect(() => formatMoney(150.5)).not.toThrow();
    expect(formatMoney(150.5)).toBe('—');

    // Negative minor units
    expect(() => formatMoney(-500)).not.toThrow();
    expect(formatMoney(-500)).toBe('—');

    // Non-number values
    expect(formatMoney('150000')).toBe('—');
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(undefined)).toBe('—');
    expect(formatMoney(NaN)).toBe('—');
    expect(formatMoney(Infinity)).toBe('—');

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
