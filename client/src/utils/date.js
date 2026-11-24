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
 * Parses either { start, end } or Postgres tstzrange string "[2026-11-25 18:30:00+00,2026-11-27 18:29:59.999+00)".
 */
export function parseOrderDuring(during) {
  if (!during) return { start: null, end: null };
  if (typeof during === 'object') {
    return { start: during.start || null, end: during.end || null };
  }
  if (typeof during === 'string') {
    const cleaned = during.replace(/^[[(]/, '').replace(/[)\]]$/, '').replace(/"/g, '');
    const parts = cleaned.split(',');
    if (parts.length === 2) {
      return { start: parts[0].trim(), end: parts[1].trim() };
    }
  }
  return { start: null, end: null };
}

/**
 * Formats a date range [start, end], or a tstzrange / { start, end } object if a single arg is passed.
 */
export function formatDateRange(startOrRange, endIso) {
  if (endIso !== undefined) {
    if (!startOrRange || !endIso) return '—';
    return `${formatDate(startOrRange)} – ${formatDate(endIso)}`;
  }
  const { start, end } = parseOrderDuring(startOrRange);
  if (!start || !end) return '—';
  return `${formatDate(start)} – ${formatDate(end)}`;
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

/**
 * Returns an array of YYYY-MM-DD strings for every day within [startDate, endDate] inclusive.
 * Used for service slot selection within booking dates (Change #4).
 * @param {string} startStr - "YYYY-MM-DD"
 * @param {string} endStr - "YYYY-MM-DD"
 * @returns {string[]}
 */
export function getDatesInRange(startStr, endStr) {
  if (!startStr || !endStr) return [];
  const dates = [];
  const [sYear, sMonth, sDay] = startStr.split('-').map(Number);
  const [eYear, eMonth, eDay] = endStr.split('-').map(Number);
  const current = new Date(sYear, sMonth - 1, sDay);
  const end = new Date(eYear, eMonth - 1, eDay);

  while (current <= end) {
    dates.push(toInputDateFormat(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

