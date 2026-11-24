/**
 * Returns the viewer's local time zone name (e.g. "Asia/Kolkata", "America/New_York").
 */
export function getUserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';
  } catch {
    return 'Local';
  }
}

/**
 * Formats an ISO date string in the user's locale.
 * @param {string|Date} isoString
 * @param {Intl.DateTimeFormatOptions} [options]
 */
export function formatDate(isoString, options = {}) {
  if (!isoString) return '—';
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      ...options,
    }).format(date);
  } catch {
    return '—';
  }
}

/**
 * Formats an ISO date and time including timezone indicator.
 */
export function formatDateTime(isoString) {
  if (!isoString) return '—';
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '—';
    const tz = getUserTimeZone();
    const formatted = new Intl.DateTimeFormat('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(date);
    return `${formatted} (${tz})`;
  } catch {
    return '—';
  }
}

/**
 * Formats a date range [start, end].
 */
export function formatDateRange(startIso, endIso) {
  if (!startIso || !endIso) return '—';
  return `${formatDate(startIso)} – ${formatDate(endIso)}`;
}

/**
 * Formats a Date object to YYYY-MM-DD for native HTML5 date input.
 */
export function toInputDateFormat(date) {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Converts a YYYY-MM-DD date input string into an ISO-8601 string with local timezone offset.
 * @param {string} dateStr - "YYYY-MM-DD"
 * @param {boolean} [isEndOfDay=false]
 */
export function toIsoWithLocalOffset(dateStr, isEndOfDay = false) {
  if (!dateStr) return null;
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day, isEndOfDay ? 23 : 0, isEndOfDay ? 59 : 0, isEndOfDay ? 59 : 0, isEndOfDay ? 999 : 0);
  return date.toISOString();
}
