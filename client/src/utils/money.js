const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const inrFormatterWithDecimals = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Formats integer minor units (paise) into localized INR currency.
 * Validates with Number.isSafeInteger to ensure no float rounding errors.
 * Returns "—" and logs console.error on invalid input without throwing (Change #4).
 *
 * @param {number} minorUnits - Amount in integer minor units (e.g. 150000 -> ₹1,500)
 * @param {Object} [options]
 * @param {boolean} [options.showDecimals=false]
 * @returns {string} Formatted currency string or "—"
 */
export function formatMoney(minorUnits, { showDecimals = false } = {}) {
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) {
    console.error(`formatMoney: Expected non-negative safe integer minor units, got: ${minorUnits}`);
    return '—';
  }

  const majorUnits = minorUnits / 100;
  if (!showDecimals && minorUnits % 100 === 0) {
    return inrFormatter.format(majorUnits);
  }
  return inrFormatterWithDecimals.format(majorUnits);
}
