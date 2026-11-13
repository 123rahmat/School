/** Calendar-safe date arithmetic for billing and academic periods (UTC date-only values). */
export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  if (!Number.isFinite(d.getTime()) || !Number.isInteger(n)) throw new RangeError('Invalid date or day offset');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Add calendar months while clamping to the final day of the target month.
 * Example: 2026-01-31 + 1 month = 2026-02-28 (not 2026-03-03).
 */
export function addMonths(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  if (!Number.isFinite(d.getTime()) || !Number.isInteger(n)) throw new RangeError('Invalid date or month offset');
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}
