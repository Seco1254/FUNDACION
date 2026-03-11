/**
 * Canonical source of "now" for the runtime.
 *
 * JS Date internally stores UTC ms-since-epoch. The "local" aspect
 * comes from the system clock — `new Date()` already captures the
 * correct instant. The helpers below exist to:
 *   1) Centralise the call-site so grep/replace is trivial.
 *   2) Expose TZ metadata for debugging (so operators can confirm
 *      the runtime's timezone matches expectations).
 */

/** Current instant as a Date, sourced from the runtime system clock. */
export function getRuntimeNow(): Date {
  return new Date();
}

/** Advance a Date by `ms` milliseconds. Pure arithmetic on the UTC epoch. */
export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

/**
 * Debug helper: returns the runtime's TZ offset and IANA zone name.
 * - `tzOffsetMin`: `Date.getTimezoneOffset()` (minutes west of UTC; e.g. UTC-5 → 300).
 * - `tz`: IANA zone string (e.g. `"America/Bogota"`) or null if unavailable.
 * - `localIso`: the current time formatted as local ISO-like string for quick comparison.
 */
export function getRuntimeTzDebug(): {
  tzOffsetMin: number;
  tz: string | null;
  localIso: string;
} {
  const d = new Date();
  let tz: string | null = null;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    /* Intl not available — tz stays null */
  }

  // Build a local ISO-like string: "2025-06-15T12:34:56-05:00"
  const pad = (n: number) => String(n).padStart(2, '0');
  const off = d.getTimezoneOffset(); // minutes west of UTC
  const sign = off <= 0 ? '+' : '-';
  const absOff = Math.abs(off);
  const offH = pad(Math.floor(absOff / 60));
  const offM = pad(absOff % 60);
  const localIso = [
    d.getFullYear(), '-', pad(d.getMonth() + 1), '-', pad(d.getDate()),
    'T', pad(d.getHours()), ':', pad(d.getMinutes()), ':', pad(d.getSeconds()),
    sign, offH, ':', offM,
  ].join('');

  return { tzOffsetMin: off, tz, localIso };
}
