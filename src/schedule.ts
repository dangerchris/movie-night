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

type Pair = [proposer: number, chooser: number];
const cycleCache = new Map<number, Pair[]>();

/**
 * The rotation for n people: a cycle of n*(n-1) weeks containing every proposer/chooser pairing
 * exactly once, split into rounds of n weeks in which everyone proposes once and chooses once.
 * Consecutive weeks (including the wrap-around) never repeat the proposer or the chooser, and when
 * possible (n >= 4) this week's chooser doesn't propose next week either.
 */
export function rotationCycle(n: number): Pair[] {
  const cached = cycleCache.get(n);
  if (cached) return cached;
  const found = n < 2 ? [[0, 0] as Pair] : searchCycle(n, true) ?? searchCycle(n, false) ?? fallbackCycle(n);
  cycleCache.set(n, found);
  return found;
}

function searchCycle(n: number, avoidHandoff: boolean): Pair[] | null {
  const len = n * (n - 1);
  const used = new Set<number>();
  const seq: Pair[] = [];
  let budget = 200_000;
  const ok = (a: Pair, b: Pair) => a[0] !== b[0] && a[1] !== b[1] && (!avoidHandoff || a[1] !== b[0]);
  const dfs = (): boolean => {
    if (--budget < 0) return false;
    if (seq.length === len) return ok(seq[len - 1], seq[0]);
    const k = seq.length;
    const round = seq.slice(k - (k % n));
    for (let p = 0; p < n; p++) {
      if (round.some((x) => x[0] === p)) continue;
      for (let c = 0; c < n; c++) {
        if (c === p || used.has(p * n + c) || round.some((x) => x[1] === c)) continue;
        const cand: Pair = [p, c];
        if (k > 0 && !ok(seq[k - 1], cand)) continue;
        used.add(p * n + c); seq.push(cand);
        if (dfs()) return true;
        used.delete(p * n + c); seq.pop();
      }
    }
    return false;
  };
  return dfs() ? seq : null;
}

/** Simple offset rotation, only used if the search gives up (very large groups). */
function fallbackCycle(n: number): Pair[] {
  const out: Pair[] = [];
  for (let r = 0; r < n - 1; r++) for (let i = 0; i < n; i++) out.push([i, (i + 1 + r) % n]);
  return out;
}

export function rotationRoles(
  date: string, anchor: string, order: string[],
): { proposer: string | null; chooser: string | null } {
  const n = order.length;
  if (n === 0) return { proposer: null, chooser: null };
  const cycle = rotationCycle(n);
  const k = Math.floor(daysBetween(anchor, date) / 7);
  const [p, c] = cycle[((k % cycle.length) + cycle.length) % cycle.length];
  return { proposer: order[p], chooser: order[c] };
}
