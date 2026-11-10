// Dates are plain "YYYY-MM-DD" strings in the configured timezone; arithmetic is done in UTC.

export function todayInTz(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

export function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const toMs = (iso: string) => Date.parse(iso + "T00:00:00Z");
const DAY = 86_400_000;

export function addDays(iso: string, n: number): string {
  return new Date(toMs(iso) + n * DAY).toISOString().slice(0, 10);
}

export function weekdayOf(iso: string): number {
  return new Date(toMs(iso)).getUTCDay();
}

export function daysBetween(a: string, b: string): number {
  return Math.round((toMs(b) - toMs(a)) / DAY);
}

/** First date on or after `iso` falling on `weekday` (0 = Sunday). */
export function nextWeekday(iso: string, weekday: number): string {
  return addDays(iso, (weekday - weekdayOf(iso) + 7) % 7);
}

export function upcomingNightDates(today: string, weekday: number, count: number): string[] {
  const first = nextWeekday(today, weekday);
  return Array.from({ length: count }, (_, i) => addDays(first, i * 7));
}

/**
 * Rotation: the night `k` weeks after the anchor has proposer = order[k mod n], so everyone
 * proposes once per round of n weeks. The chooser is `offset` places after the proposer, where
 * the offset steps through 1..n-1 from one round to the next; over n*(n-1) weeks every
 * proposer/chooser pairing happens exactly once and nobody chooses for themselves.
 */
export function rotationRoles(
  date: string, anchor: string, order: string[],
): { proposer: string | null; chooser: string | null } {
  const n = order.length;
  if (n === 0) return { proposer: null, chooser: null };
  const k = Math.floor(daysBetween(anchor, date) / 7);
  const mod = (x: number, m: number) => ((x % m) + m) % m;
  if (n === 1) return { proposer: order[0], chooser: order[0] };
  const round = Math.floor(k / n);
  const offset = 1 + mod(round, n - 1);
  return { proposer: order[mod(k, n)], chooser: order[mod(k + offset, n)] };
}
