import type { Database } from "bun:sqlite";
import { Hono, type Context } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { identify, PICKER_COOKIE, type AuthConfig, type Identity } from "./auth.ts";
import { addDays, daysBetween, isIsoDate, isValidTimezone, rotationCycle, todayInTz, weekdayOf } from "./schedule.ts";
import { TmdbError, type MovieDetails, type MovieSource } from "./tmdb.ts";
import type { Library } from "./jellyfin.ts";

export const PROPOSAL_COUNT = 3;
const MOVIE_CACHE_MS = 7 * 86_400_000;
const UPCOMING_DAYS = 28;  // show the nights in the next four weeks...
const UPCOMING_MIN = 4;    // ...but at least this many (and always every night in the lineup)
const PAST_COUNT = 12;
const MAX_SCAN_DAYS = 3 * 366;

export interface AppDeps {
  db: Database;
  auth: AuthConfig;
  movies: MovieSource;
  adminEmails: string[];
  library?: Library | null;
  now?: () => Date;
}

interface Participant {
  email: string;
  name: string;
  position: number;
  active: number;
  is_admin: number;
}

/**
 * A night in the lineup. Nights still to come are ordered by `seq` and fill the calendar's upcoming
 * dates in that order, so changing dates never leaves gaps; once a date passes, the night that held
 * it is recorded with `held_on`.
 */
interface Entry {
  id: number;
  seq: number;
  held_on: string | null;
  proposer_email: string | null;
  chooser_email: string | null;
  selected_tmdb_id: number | null;
  selected_by: string | null;
  selected_at: string | null;
}

interface CalendarRow { date: string; kind: "skip" | "extra" | "time"; time: string | null; moved_from: string | null }

interface Settings {
  title: string;
  schedule: NightDay[];   // recurring nights, sorted by weekday
  timezone: string;
  region: string;
  rotationBase: number;   // where in the rotation cycle to start when there's no history
}

interface NightDay { weekday: number; time: string } // 0 = Sunday; HH:MM

/** A date on the calendar that has a movie night. */
interface Slot { date: string; time: string; regularTime: string; extra: boolean; movedFrom: string | null; customTime: boolean }

type Roles = { proposer: string | null; chooser: string | null };

/** An upcoming night: a calendar slot, the lineup entry filling it (if any), and its roles. */
interface Upcoming extends Slot { index: number; entry: Entry | null; roles: Roles }

const DEFAULTS: Record<string, string> = {
  title: "Movie Night",
  night_weekday: "6", // legacy single-night settings, used until a schedule is saved
  night_time: "19:30",
  timezone: "America/Toronto",
  region: "CA",
};

type Env = { Bindings: object; Variables: { ident: Identity; me: Participant | null } };

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) { super(message ?? code); }
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "Netflix Standard with Ads" -> "Netflix"; "Crave Amazon Channel" -> "Crave (via Prime)", dropped if Crave is listed. */
export function tidyProviders(names: string[]): string[] {
  const base = names.map((n) => n.replace(/\s+(Standard\s+)?with Ads$/i, "").replace(/\s+Amazon Channel$/i, " (via Prime)"));
  const set = new Set(base);
  return [...set].filter((n) => !(n.endsWith(" (via Prime)") && set.has(n.slice(0, -" (via Prime)".length))));
}

export function createApp({ db, auth, movies, adminEmails, library = null, now = () => new Date() }: AppDeps) {
  const admins = new Set(adminEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));

  // ---------- data access ----------

  const q = {
    participant: db.query<Participant, [string]>("SELECT * FROM participants WHERE email = ?"),
    participants: db.query<Participant, []>("SELECT * FROM participants ORDER BY active DESC, position, name"),
    activeOrder: db.query<{ email: string }, []>("SELECT email FROM participants WHERE active = 1 ORDER BY position, name"),
    maxPos: db.query<{ m: number | null }, []>("SELECT MAX(position) AS m FROM participants"),
    entry: db.query<Entry, [number]>("SELECT * FROM lineup WHERE id = ?"),
    lineup: db.query<Entry, []>("SELECT * FROM lineup WHERE held_on IS NULL ORDER BY seq, id"),
    heldOn: db.query<Entry, [string]>("SELECT * FROM lineup WHERE held_on = ? ORDER BY id DESC LIMIT 1"),
    recentHeld: db.query<Entry, [number]>(
      `SELECT * FROM lineup WHERE held_on IS NOT NULL AND proposer_email IS NOT NULL AND chooser_email IS NOT NULL
       ORDER BY held_on DESC, id DESC LIMIT ?`),
    pastWithData: db.query<Entry, [number]>(
      `SELECT l.* FROM lineup l WHERE l.held_on IS NOT NULL
         AND (l.selected_tmdb_id IS NOT NULL OR EXISTS (SELECT 1 FROM lineup_proposals p WHERE p.night_id = l.id))
       ORDER BY l.held_on DESC, l.id DESC LIMIT ?`),
    proposals: db.query<{ slot: number; tmdb_id: number; proposed_by: string | null }, [number]>(
      "SELECT slot, tmdb_id, proposed_by FROM lineup_proposals WHERE night_id = ? ORDER BY slot"),
    // Movies passed over on settled nights (a pick was made, or the night is past) and never picked anywhere.
    passedOver: db.query<{ tmdb_id: number; night_id: number; held_on: string | null; proposed_by: string | null; slot: number }, []>(
      `SELECT p.tmdb_id, p.night_id, l.held_on, p.proposed_by, p.slot
         FROM lineup_proposals p JOIN lineup l ON l.id = p.night_id
        WHERE (l.selected_tmdb_id IS NOT NULL OR l.held_on IS NOT NULL)
          AND p.tmdb_id NOT IN (SELECT selected_tmdb_id FROM lineup WHERE selected_tmdb_id IS NOT NULL)`),
    picked: db.query<{ id: number; night_id: number; held_on: string | null }, []>(
      "SELECT selected_tmdb_id AS id, id AS night_id, held_on FROM lineup WHERE selected_tmdb_id IS NOT NULL"),
    calendar: db.query<CalendarRow, []>("SELECT * FROM calendar"),
    calendarAt: db.query<CalendarRow, [string]>("SELECT * FROM calendar WHERE date = ?"),
    putCalendar: db.query("INSERT OR REPLACE INTO calendar (date, kind, time, moved_from) VALUES (?, ?, ?, ?)"),
    dropCalendar: db.query("DELETE FROM calendar WHERE date = ?"),
    cachedMovie: db.query<{ data: string; fetched_at: number }, [number]>("SELECT data, fetched_at FROM movies WHERE tmdb_id = ?"),
    putMovie: db.query("INSERT OR REPLACE INTO movies (tmdb_id, data, fetched_at) VALUES (?, ?, ?)"),
    settingRows: db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings"),
    putSetting: db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"),
    insertEntry: db.query<{ id: number }, [number, string | null, string | null]>(
      "INSERT INTO lineup (seq, proposer_email, chooser_email) VALUES (?, ?, ?) RETURNING id"),
    setSeq: db.query("UPDATE lineup SET seq = ? WHERE id = ?"),
  };

  function getSettings(): Settings {
    const raw: Record<string, string> = { ...DEFAULTS };
    for (const r of q.settingRows.all()) raw[r.key] = r.value;
    const schedule: NightDay[] = raw.schedule
      ? JSON.parse(raw.schedule)
      : [{ weekday: Number(raw.night_weekday), time: raw.night_time }];
    return { title: raw.title, schedule, timezone: raw.timezone, region: raw.region, rotationBase: Number(raw.rotation_base ?? 0) };
  }

  const setting = (key: string) => q.settingRows.all().find((r) => r.key === key)?.value ?? null;
  const today = (s: Settings) => todayInTz(s.timezone, now());

  async function getMovie(id: number, refresh = false): Promise<MovieDetails> {
    const cached = q.cachedMovie.get(id);
    const fresh = cached && now().getTime() - cached.fetched_at < MOVIE_CACHE_MS && "providers" in JSON.parse(cached.data);
    if (cached && fresh && !refresh) return JSON.parse(cached.data);
    try {
      const m = await movies.details(id);
      q.putMovie.run(id, JSON.stringify(m), now().getTime());
      return m;
    } catch (e) {
      if (cached) return JSON.parse(cached.data);
      throw e;
    }
  }

  function cachedMovie(id: number): MovieDetails | { id: number; title: string } {
    const c = q.cachedMovie.get(id);
    return c ? JSON.parse(c.data) : { id, title: `TMDB #${id}` };
  }

  // ---------- calendar ----------

  const weekdays = (s: Settings) => s.schedule.map((d) => d.weekday);
  const regularTime = (date: string, s: Settings) =>
    s.schedule.find((d) => d.weekday === weekdayOf(date))?.time ?? s.schedule[0]?.time ?? "19:30";

  /** Movie night dates from `from`: through `to` (inclusive) and until there are at least `min`. */
  function slots(s: Settings, from: string, to: string, min = 0): Slot[] {
    const cal = new Map(q.calendar.all().map((r) => [r.date, r]));
    const regular = new Set(weekdays(s));
    const out: Slot[] = [];
    for (let i = 0; i <= MAX_SCAN_DAYS; i++) {
      const date = addDays(from, i);
      if (date > to && out.length >= min) break;
      const row = cal.get(date);
      if (row?.kind === "skip") continue;
      const isRegular = regular.has(weekdayOf(date));
      if (!isRegular && row?.kind !== "extra") continue;
      const reg = regularTime(date, s);
      out.push({
        date, time: row?.time ?? reg, regularTime: reg, extra: !isRegular,
        movedFrom: row?.kind === "extra" ? row.moved_from : null, customTime: !!row?.time && row.time !== reg,
      });
    }
    return out;
  }

  const isSlot = (s: Settings, date: string) => slots(s, date, date).length === 1;

  /** Take a date off the calendar (skip a regular date, or drop an extra one). */
  function removeDate(s: Settings, date: string) {
    const row = q.calendarAt.get(date);
    if (weekdays(s).includes(weekdayOf(date))) q.putCalendar.run(date, "skip", null, null);
    else if (row) q.dropCalendar.run(date);
  }

  // ---------- lineup ----------

  /** Record nights whose dates have passed: each date since the last check takes the next night in line. */
  function settle(s: Settings) {
    const yesterday = addDays(today(s), -1);
    const through = setting("lineup_through");
    if (through && through >= yesterday) return;
    db.transaction(() => {
      if (through) {
        const passed = slots(s, addDays(through, 1), yesterday);
        const waiting = q.lineup.all();
        passed.slice(0, waiting.length).forEach((slot, i) =>
          db.query("UPDATE lineup SET held_on = ? WHERE id = ?").run(slot.date, waiting[i].id));
      }
      q.putSetting.run("lineup_through", yesterday);
    })();
  }

  /** People who have since been removed don't keep upcoming roles. */
  function storedRoles(e: Entry | null, order: string[]): Roles {
    const keep = (x: string | null | undefined) => (x && order.includes(x) ? x : null);
    return { proposer: keep(e?.proposer_email), chooser: keep(e?.chooser_email) };
  }

  /**
   * Plans roles for upcoming nights. Nights in the lineup keep their stored roles. The rest are filled
   * with pairings from the rotation cycle, continuing from the most recent night, so that nobody
   * proposes or chooses on consecutive nights (and, with 4+ people, the previous chooser doesn't propose
   * next), preferring pairings not used in the last few nights and otherwise the natural cycle order.
   * With nothing stored this is exactly the rotation cycle.
   */
  function plan(s: Settings, fixed: Roles[]): Roles[] {
    const order = q.activeOrder.all().map((p) => p.email);
    const n = order.length;
    if (n === 0) return fixed.map(() => ({ proposer: null, chooser: null }));
    const cycle: Roles[] = rotationCycle(n).map(([p, c]) => ({ proposer: order[p], chooser: order[c] }));
    const key = (r: Roles) => `${r.proposer}>${r.chooser}`;
    const indexOf = new Map(cycle.map((r, i) => [key(r), i]));
    const isFull = (f: Roles) => !!(f.proposer && f.chooser);

    const history = q.recentHeld.all(3).reverse().map((e) => ({ proposer: e.proposer_email, chooser: e.chooser_email }));
    const recent = history.map(key);
    let prev: Roles | null = history.at(-1) ?? null;
    let ptr = prev && indexOf.has(key(prev)) ? indexOf.get(key(prev))! : s.rotationBase - 1;

    // Back-to-back repeats cost 2 each; the previous chooser proposing next (4+ people) and reusing a
    // pairing from the last few nights cost 1.
    const cost = (a: Roles | null, b: Roles | null) => !a || !b ? 0
      : +(a.proposer === b.proposer) * 2 + +(a.chooser === b.chooser) * 2 + (n >= 4 && a.chooser === b.proposer ? 1 : 0);
    const reused = (c: Roles, hist: string[]) => (hist.slice(-3).includes(key(c)) ? 1 : 0);
    const candidates = (from: number, f: Roles) =>
      Array.from({ length: cycle.length }, (_, j) => cycle[(((from + 1 + j) % cycle.length) + cycle.length) % cycle.length])
        .filter((c) => (!f.proposer || c.proposer === f.proposer) && (!f.chooser || c.chooser === f.chooser));

    // Plan a run of open nights at once, ending before `after` (a fixed night) if any.
    const solve = (run: Roles[], after: Roles | null): Roles[] => {
      let best: { score: number; picks: Roles[] } = { score: Infinity, picks: [] };
      let budget = 20_000;
      const dfs = (t: number, before: Roles | null, from: number, score: number, picks: Roles[]) => {
        if (score >= best.score || --budget < 0) return;
        if (t === run.length) {
          const total = score + cost(before, after) + (after ? reused(after, [...recent, ...picks.map(key)]) : 0);
          if (total < best.score) best = { score: total, picks: [...picks] };
          return;
        }
        const f = run[t];
        const cands = candidates(from, f);
        if (!cands.length) cands.push({ proposer: f.proposer ?? cycle[0].proposer, chooser: f.chooser ?? cycle[0].chooser });
        for (const c of cands) {
          picks.push(c);
          dfs(t + 1, c, indexOf.get(key(c)) ?? from + 1, score + cost(before, c) + reused(c, [...recent, ...picks.slice(0, -1).map(key)]), picks);
          picks.pop();
        }
      };
      dfs(0, prev, ptr, 0, []);
      return best.picks;
    };

    const out: Roles[] = [];
    let i = 0;
    while (i < fixed.length) {
      if (isFull(fixed[i])) {
        prev = fixed[i];
        out.push(prev);
        recent.push(key(prev));
        if (indexOf.has(key(prev))) ptr = indexOf.get(key(prev))!;
        i++;
        continue;
      }
      let j = i;
      while (j < fixed.length && !isFull(fixed[j])) j++;
      const next = j < fixed.length ? fixed[j] : null;
      // A run leading up to a fixed night is planned as a whole; trailing open nights one at a time.
      const runs = next ? [[i, j]] : Array.from({ length: j - i }, (_, k) => [i + k, i + k + 1]);
      for (const [a, b] of runs) {
        for (const pick of solve(fixed.slice(a, b), b === j ? next : null)) {
          out.push(pick);
          recent.push(key(pick));
          prev = pick;
          ptr = indexOf.get(key(pick)) ?? ptr + 1;
        }
      }
      i = j;
    }
    return out;
  }

  /** Upcoming nights from today through `through` (at least every lineup night plus one open night). */
  function upcoming(s: Settings, through = addDays(today(s), UPCOMING_DAYS - 1)): Upcoming[] {
    settle(s);
    const waiting = q.lineup.all();
    const order = q.activeOrder.all().map((p) => p.email);
    const list = slots(s, today(s), through, Math.max(UPCOMING_MIN, waiting.length + 1));
    const fixed = list.map((_, i) => storedRoles(waiting[i] ?? null, order));
    const roles = plan(s, fixed);
    return list.map((slot, i) => ({ ...slot, index: i, entry: waiting[i] ?? null, roles: roles[i] }));
  }

  /**
   * Make sure upcoming nights 0..index are in the lineup (with the roles they're showing), so the
   * lineup stays contiguous; returns the entry at `index`.
   */
  function claim(s: Settings, index: number): Entry {
    const list = upcoming(s, today(s));
    const nights = list.length > index ? list : upcoming(s, slots(s, today(s), today(s), index + 1)[index].date);
    const waiting = q.lineup.all();
    let seq = waiting.length ? waiting[waiting.length - 1].seq : 0;
    for (let i = waiting.length; i <= index; i++) q.insertEntry.get(++seq, nights[i].roles.proposer, nights[i].roles.chooser);
    return q.lineup.all()[index];
  }

  /** Put an entry at position `index` in the lineup (filling any open nights before it with their roles). */
  function placeAt(s: Settings, entry: Entry, index: number) {
    const others = q.lineup.all().filter((e) => e.id !== entry.id);
    if (index > others.length) {
      // Open nights between the end of the lineup and the entry's new place get planned roles.
      const order = q.activeOrder.all().map((p) => p.email);
      const fixed: Roles[] = [...others.map((e) => storedRoles(e, order))];
      while (fixed.length < index) fixed.push({ proposer: null, chooser: null });
      fixed.push(storedRoles(entry, order));
      const roles = plan(s, fixed);
      const ids = others.map((e) => e.id);
      for (let i = others.length; i < index; i++) ids.push(q.insertEntry.get(0, roles[i].proposer, roles[i].chooser)!.id);
      ids.push(entry.id);
      ids.forEach((id, i) => q.setSeq.run(i + 1, id));
    } else {
      const ids = others.map((e) => e.id);
      ids.splice(index, 0, entry.id);
      ids.forEach((id, i) => q.setSeq.run(i + 1, id));
    }
  }

  /** Resolve a night by its date: an upcoming night (by position) or a past one. */
  function resolve(s: Settings, date: string): { kind: "upcoming"; night: Upcoming } | { kind: "past"; entry: Entry } {
    if (!isIsoDate(date)) throw new HttpError(404, "not_a_night", "That date is not a movie night");
    if (date >= today(s)) {
      const night = upcoming(s, date).find((n) => n.date === date);
      if (night) return { kind: "upcoming", night };
    } else {
      const entry = q.heldOn.get(date);
      if (entry) return { kind: "past", entry };
    }
    throw new HttpError(404, "not_a_night", "That date is not a movie night");
  }

  /** Where each lineup night is (or was) held: past date, or its upcoming date. */
  function datesById(s: Settings): Map<number, string> {
    const m = new Map<number, string>();
    for (const n of upcoming(s)) if (n.entry) m.set(n.entry.id, n.date);
    return m;
  }

  // ---------- views ----------

  function personView(email: string | null, names: Map<string, string>) {
    return email ? { email, name: names.get(email) ?? email } : null;
  }

  function movieView(m: any, region: string) {
    const certs: Record<string, string> = m.certifications ?? {};
    const { certifications, providers, ...rest } = m;
    return {
      ...rest,
      certification: certs[region] ?? certs.US ?? null,
      // null = not fetched yet (older cache entry); [] = not streaming in this region.
      streaming: providers ? tidyProviders(providers[region] ?? []) : null,
      region,
    };
  }

  function nightView(
    s: Settings, me: Participant, names: Map<string, string>,
    n: { date: string; slot: Slot | null; entry: Entry | null; roles: Roles; isPast: boolean },
  ) {
    const proposals = n.entry ? q.proposals.all(n.entry.id).map((p) => movieView(cachedMovie(p.tmdb_id), s.region)) : [];
    const selectedId = n.entry?.selected_tmdb_id ?? null;
    const full = proposals.length === PROPOSAL_COUNT;
    const t = today(s);
    return {
      date: n.date,      // identifies the night in the API
      on: n.date,
      time: n.slot?.time ?? regularTime(n.date, s),
      regularTime: n.slot?.regularTime ?? regularTime(n.date, s),
      movedFrom: n.slot?.movedFrom ?? null,
      extra: n.slot?.extra ?? false,
      customTime: n.slot?.customTime ?? false,
      isPast: n.isPast,
      isToday: n.date === t,
      inLineup: !!n.entry,
      proposer: personView(n.roles.proposer, names),
      chooser: personView(n.roles.chooser, names),
      proposals,
      selectedId,
      selectedBy: personView(n.entry?.selected_by ?? null, names),
      // What you can do because you hold the role. Admins can do both at any time (see canOverride).
      canPropose: n.roles.proposer === me.email && !n.isPast && selectedId === null,
      canChoose: n.roles.chooser === me.email && full && !n.isPast,
      canOverride: !!me.is_admin,
    };
  }

  function stateView(me: Participant) {
    const s = getSettings();
    const t = today(s);
    const all = q.participants.all();
    const names = new Map(all.map((p) => [p.email, p.name]));
    const list = upcoming(s);
    const end = list.at(-1)?.date ?? t;
    const skipped = q.calendar.all()
      .filter((r) => r.kind === "skip" && r.date >= t && r.date <= end && weekdays(s).includes(weekdayOf(r.date)))
      .map((r) => r.date).sort();
    return {
      settings: s,
      today: t,
      me: participantView(me),
      participants: all.map(participantView),
      upcoming: list.map((n) => nightView(s, me, names, { date: n.date, slot: n, entry: n.entry, roles: n.roles, isPast: false })),
      skipped,
      past: q.pastWithData.all(PAST_COUNT).map((e) =>
        nightView(s, me, names, { date: e.held_on!, slot: null, entry: e, roles: { proposer: e.proposer_email, chooser: e.chooser_email }, isPast: true })),
    };
  }

  function participantView(p: Participant) {
    return { email: p.email, name: p.name, position: p.position, active: !!p.active, isAdmin: !!p.is_admin };
  }

  function addParticipant(email: string, name: string, isAdmin: boolean): Participant {
    const pos = (q.maxPos.get()?.m ?? -1) + 1;
    db.query("INSERT INTO participants (email, name, position, is_admin) VALUES (?, ?, ?, ?)")
      .run(email, name, pos, isAdmin ? 1 : 0);
    return q.participant.get(email)!;
  }

  const defaultName = (email: string) => {
    const local = email.split("@")[0].replace(/[._-]+/g, " ");
    return local.charAt(0).toUpperCase() + local.slice(1);
  };

  // ---------- app ----------

  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.code, message: err.message }, err.status as any);
    if (err instanceof TmdbError) return c.json({ error: "tmdb", message: err.message }, err.status as any);
    console.error(err);
    return c.json({ error: "internal", message: "Something went wrong" }, 500);
  });

  app.use("/api/*", async (c, next) => {
    const server = c.env as { requestIP?: (r: Request) => { address: string } | null } | undefined;
    const addr = server?.requestIP?.(c.req.raw)?.address ?? null;
    const ident = await identify(c.req.raw, auth, addr);
    let me: Participant | null = null;
    if (ident.kind === "access") {
      me = q.participant.get(ident.email);
      if (!me && admins.has(ident.email)) me = addParticipant(ident.email, defaultName(ident.email), true);
    } else if (ident.kind === "picker" && ident.email) {
      me = q.participant.get(ident.email);
    }
    if (me && !me.active) me = null;
    c.set("ident", ident);
    c.set("me", me);
    await next();
  });

  const requireMe = (c: Context<Env>) => {
    const me = c.get("me");
    if (!me) {
      const ident = c.get("ident");
      if (ident.kind === "denied") throw new HttpError(401, "unauthenticated", ident.reason);
      throw new HttpError(403, "not_participant", "You are not a movie night participant yet");
    }
    return me;
  };
  const requireAdmin = (c: Context<Env>) => {
    const me = requireMe(c);
    if (!me.is_admin) throw new HttpError(403, "forbidden", "Admins only");
    return me;
  };
  const body = async (c: Context<Env>): Promise<any> => {
    try { return await c.req.json(); } catch { throw new HttpError(400, "bad_json"); }
  };

  // Who am I / how do I sign in.
  app.get("/api/me", (c) => {
    const ident = c.get("ident");
    const me = c.get("me");
    const s = getSettings();
    const res: any = { mode: ident.kind, title: s.title, me: me ? participantView(me) : null };
    if (ident.kind === "denied") res.reason = ident.reason;
    if (ident.kind === "access") res.email = ident.email;
    if (ident.kind === "picker") {
      res.choices = q.participants.all().filter((p) => p.active).map((p) => ({ email: p.email, name: p.name }));
      res.needsSetup = res.choices.length === 0;
    }
    return c.json(res);
  });

  // LAN: pick who you are.
  app.post("/api/picker", async (c) => {
    if (c.get("ident").kind !== "picker") throw new HttpError(403, "forbidden");
    const { email } = await body(c);
    const p = typeof email === "string" ? q.participant.get(email.toLowerCase()) : null;
    if (!p || !p.active) throw new HttpError(404, "unknown_participant");
    setCookie(c, PICKER_COOKIE, p.email, { path: "/", httpOnly: true, sameSite: "Lax", maxAge: 400 * 86_400 });
    return c.json({ ok: true });
  });

  app.delete("/api/picker", (c) => {
    deleteCookie(c, PICKER_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // LAN: first run, create the first (admin) participant.
  app.post("/api/setup", async (c) => {
    if (c.get("ident").kind !== "picker") throw new HttpError(403, "forbidden");
    if (q.participants.all().length > 0) throw new HttpError(409, "already_setup");
    const { email, name } = await body(c);
    const e = String(email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(e)) throw new HttpError(400, "bad_email");
    const p = addParticipant(e, String(name ?? "").trim() || defaultName(e), true);
    setCookie(c, PICKER_COOKIE, p.email, { path: "/", httpOnly: true, sameSite: "Lax", maxAge: 400 * 86_400 });
    return c.json({ ok: true });
  });

  app.get("/api/state", (c) => c.json(stateView(requireMe(c))));

  /** Picked movies -> the date of the night they were picked for. */
  function watchedMap(s: Settings) {
    const dates = datesById(s);
    return new Map(q.picked.all().map((r) => [r.id, r.held_on ?? dates.get(r.night_id) ?? null]));
  }

  const participantNames = () => q.participants.all().filter((p) => p.active).map((p) => p.name);

  /** Library contents keyed by TMDB id, or null if Jellyfin isn't configured or is unreachable. */
  async function libraryIndex() {
    if (!library) return null;
    try {
      const { movies: list, matchedUsers } = await library.movies(participantNames());
      return { byTmdb: new Map(list.map((m) => [m.tmdbId, m])), list, matchedUsers };
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  // Fetch TMDB details for library movies in the background so posters and hover cards are ready.
  let warming = false;
  async function warmMovieCache(ids: number[]) {
    if (warming) return;
    warming = true;
    try {
      const todo = ids.filter((id) => !q.cachedMovie.get(id));
      for (let i = 0; i < todo.length; i += 4)
        await Promise.allSettled(todo.slice(i, i + 4).map((id) => getMovie(id)));
    } finally {
      warming = false;
    }
  }

  app.get("/api/search", async (c) => {
    requireMe(c);
    const query = (c.req.query("q") ?? "").trim();
    if (query.length < 2) return c.json({ results: [] });
    const watched = watchedMap(getSettings());
    const [results, lib] = await Promise.all([movies.search(query), libraryIndex()]);
    return c.json({
      results: results.map((r) => {
        const inLib = lib?.byTmdb.get(r.id);
        return { ...r, watched: watched.get(r.id) ?? null, inLibrary: !!inLib, seenBy: inLib?.seenBy ?? [] };
      }),
    });
  });

  // Library movies none of the participants have played (and that movie night hasn't picked).
  app.get("/api/library", async (c) => {
    requireMe(c);
    const lib = await libraryIndex();
    if (!lib) return c.json({ enabled: !!library, movies: [], matchedUsers: [] });
    const s = getSettings();
    const watched = watchedMap(s);
    const unseen = lib.list.filter((m) => m.seenBy.length === 0 && !watched.has(m.tmdbId));
    void warmMovieCache(unseen.map((m) => m.tmdbId));
    return c.json({
      enabled: true,
      matchedUsers: lib.matchedUsers,
      movies: unseen.map((m) => {
        const cached = q.cachedMovie.get(m.tmdbId);
        const base = cached ? movieView(JSON.parse(cached.data), s.region) : { id: m.tmdbId, title: m.title, year: m.year ? String(m.year) : null, posterPath: null };
        return { ...base, inLibrary: true, jellyfinId: m.jellyfinId, added: m.added };
      }),
    });
  });

  app.get("/api/library/poster/:id", async (c) => {
    requireMe(c);
    const id = c.req.param("id");
    if (!library || !/^[0-9a-f]{32}$/i.test(id)) throw new HttpError(404, "not_found");
    return library.poster(id);
  });

  // Movies passed over on settled nights and never picked: ready-made options for the proposer.
  app.get("/api/proposal-history", (c) => {
    requireMe(c);
    const s = getSettings();
    const names = new Map(q.participants.all().map((p) => [p.email, p.name]));
    const dates = datesById(s);
    let excludeId: number | null = null;
    const exclude = c.req.query("exclude") ?? "";
    if (exclude) {
      try {
        const r = resolve(s, exclude);
        excludeId = r.kind === "past" ? r.entry.id : r.night.entry?.id ?? null;
      } catch { /* not a night */ }
    }
    const rows = q.passedOver.all()
      .filter((r) => r.night_id !== excludeId)
      .map((r) => ({ ...r, on: r.held_on ?? dates.get(r.night_id) ?? "" }))
      .sort((a, b) => b.on.localeCompare(a.on) || a.slot - b.slot);
    const times = new Map<number, number>();
    for (const r of rows) times.set(r.tmdb_id, (times.get(r.tmdb_id) ?? 0) + 1);
    const seen = new Set<number>();
    const list = [];
    for (const r of rows) {
      if (seen.has(r.tmdb_id)) continue;
      seen.add(r.tmdb_id);
      const m = movieView(cachedMovie(r.tmdb_id), s.region);
      list.push({ ...m, lastProposed: r.on, proposedBy: r.proposed_by ? names.get(r.proposed_by) ?? r.proposed_by : null, times: times.get(r.tmdb_id) });
    }
    return c.json({ movies: list });
  });

  app.get("/api/movie/:id", async (c) => {
    requireMe(c);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "bad_id");
    return c.json(movieView(await getMovie(id), getSettings().region));
  });

  app.put("/api/nights/:date/proposals", async (c) => {
    const me = requireMe(c);
    const s = getSettings();
    const r = resolve(s, c.req.param("date"));
    const admin = !!me.is_admin;
    const roles = r.kind === "upcoming" ? r.night.roles : { proposer: r.entry.proposer_email, chooser: r.entry.chooser_email };
    const current = r.kind === "upcoming" ? r.night.entry : r.entry;
    if (roles.proposer !== me.email && !admin) throw new HttpError(403, "not_proposer", "You are not the proposer for this night");
    if (r.kind === "past" && !admin) throw new HttpError(409, "past", "That night has passed");
    if (current?.selected_tmdb_id && !admin) throw new HttpError(409, "already_selected", "A movie has already been picked");

    const { tmdbIds } = await body(c);
    const ids = Array.isArray(tmdbIds) ? tmdbIds.map(Number) : [];
    if (ids.length !== PROPOSAL_COUNT || ids.some((n) => !Number.isInteger(n) || n <= 0) || new Set(ids).size !== ids.length)
      throw new HttpError(400, "bad_proposals", `Pick ${PROPOSAL_COUNT} different movies`);
    await Promise.all(ids.map((id) => getMovie(id))); // validates ids and warms the cache

    db.transaction(() => {
      const entry = r.kind === "upcoming" ? claim(s, r.night.index) : r.entry;
      // The night keeps these roles from now on.
      db.query("UPDATE lineup SET proposer_email = ?, chooser_email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(roles.proposer, roles.chooser, entry.id);
      db.query("DELETE FROM lineup_proposals WHERE night_id = ?").run(entry.id);
      const ins = db.query("INSERT INTO lineup_proposals (night_id, slot, tmdb_id, proposed_by) VALUES (?, ?, ?, ?)");
      ids.forEach((id, slot) => ins.run(entry.id, slot, id, me.email));
      if (entry.selected_tmdb_id && !ids.includes(entry.selected_tmdb_id))
        db.query("UPDATE lineup SET selected_tmdb_id = NULL, selected_by = NULL, selected_at = NULL WHERE id = ?").run(entry.id);
    })();
    return c.json(stateView(me));
  });

  app.put("/api/nights/:date/selection", async (c) => {
    const me = requireMe(c);
    const s = getSettings();
    const r = resolve(s, c.req.param("date"));
    const admin = !!me.is_admin;
    const entry = r.kind === "upcoming" ? r.night.entry : r.entry;
    const chooser = r.kind === "upcoming" ? r.night.roles.chooser : r.entry.chooser_email;
    if (chooser !== me.email && !admin) throw new HttpError(403, "not_chooser", "You are not the chooser for this night");
    if (r.kind === "past" && !admin) throw new HttpError(409, "past", "That night has passed");
    const proposed = entry ? q.proposals.all(entry.id).map((p) => p.tmdb_id) : [];
    if (!entry || proposed.length !== PROPOSAL_COUNT) throw new HttpError(409, "no_proposals", "The proposer hasn't set the movies yet");

    const { tmdbId } = await body(c);
    if (tmdbId === null) {
      db.query("UPDATE lineup SET selected_tmdb_id = NULL, selected_by = NULL, selected_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(entry.id);
    } else {
      const id = Number(tmdbId);
      if (!proposed.includes(id)) throw new HttpError(400, "not_proposed", "That movie wasn't one of the choices");
      db.query("UPDATE lineup SET selected_tmdb_id = ?, selected_by = ?, selected_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(id, me.email, entry.id);
    }
    return c.json(stateView(me));
  });

  /**
   * Move a night to another date and/or give it its own start time. The night keeps its roles,
   * choices and pick; the nights after it close up behind it. `on: null` puts a moved night back.
   */
  app.put("/api/nights/:date/schedule", async (c) => {
    const me = requireAdmin(c);
    const s = getSettings();
    const date = c.req.param("date");
    const r = resolve(s, date);
    const b = await body(c);
    const t = today(s);
    const time = "time" in b && b.time !== null && b.time !== "" ? String(b.time) : null;
    if (time !== null && !TIME_RE.test(time)) throw new HttpError(400, "bad_time", "Pick a valid time");

    db.transaction(() => {
      if (r.kind === "past") {
        // Correct when a past night happened (or bring it back into the lineup).
        const on = "on" in b && b.on ? String(b.on) : date;
        if (!isIsoDate(on)) throw new HttpError(400, "bad_date", "Pick a valid date");
        if (on < t) {
          if (on !== date && q.heldOn.get(on)) throw new HttpError(409, "date_taken", "Another night was held on that date");
          db.query("UPDATE lineup SET held_on = ? WHERE id = ?").run(on, r.entry.id);
          return;
        }
        if (!isSlot(s, on)) q.putCalendar.run(on, "extra", time, null);
        db.query("UPDATE lineup SET held_on = NULL WHERE id = ?").run(r.entry.id);
        placeAt(s, r.entry, slots(s, t, on).findIndex((x) => x.date === on));
        return;
      }

      const night = r.night;
      const putBack = "on" in b && (b.on === null || b.on === "");
      const on = putBack ? night.movedFrom ?? date : "on" in b ? String(b.on) : date;
      if (!isIsoDate(on)) throw new HttpError(400, "bad_date", "Pick a valid date");

      if (on === date) {
        // Time only.
        const row = q.calendarAt.get(date);
        const reg = regularTime(date, s);
        if (row?.kind === "extra") q.putCalendar.run(date, "extra", time, row.moved_from);
        else if (time === null || time === reg) { if (row?.kind === "time") q.dropCalendar.run(date); }
        else q.putCalendar.run(date, "time", time, null);
        return;
      }

      if (!putBack && on >= t && isSlot(s, on))
        throw new HttpError(409, "date_taken", "That date already has a movie night. To hold this night then, skip this date instead.");
      if (!putBack && on < t && q.heldOn.get(on)) throw new HttpError(409, "date_taken", "Another night was held on that date");
      const entry = night.entry ?? claim(s, night.index);
      const movedFrom = putBack ? null : night.movedFrom ?? (night.extra ? null : date);
      removeDate(s, date);
      if (putBack) {
        if (q.calendarAt.get(on)?.kind === "skip") q.dropCalendar.run(on);
        if (time !== null && time !== regularTime(on, s)) q.putCalendar.run(on, "time", time, null);
      } else if (on < t) {
        // Moved into the past: it happened then.
        db.query("UPDATE lineup SET held_on = ? WHERE id = ?").run(on, entry.id);
        return;
      } else if (!isSlot(s, on)) {
        q.putCalendar.run(on, "extra", time, movedFrom);
      } else if (time !== null && time !== regularTime(on, s)) {
        q.putCalendar.run(on, "time", time, null);
      }
      placeAt(s, q.entry.get(entry.id)!, slots(s, t, on).findIndex((x) => x.date === on));
    })();
    return c.json(stateView(me));
  });

  // Skip a date: no movie night then; the nights after it move up.
  app.put("/api/nights/:date/skip", async (c) => {
    const me = requireAdmin(c);
    const s = getSettings();
    const r = resolve(s, c.req.param("date"));
    if (r.kind === "past") throw new HttpError(409, "past", "That night has passed");
    db.transaction(() => removeDate(s, r.night.date))();
    return c.json(stateView(me));
  });

  // Undo a skipped regular date.
  app.delete("/api/skipped/:date", (c) => {
    const me = requireAdmin(c);
    const date = c.req.param("date");
    if (q.calendarAt.get(date)?.kind === "skip") q.dropCalendar.run(date);
    return c.json(stateView(me));
  });

  app.put("/api/nights/:date/roles", async (c) => {
    const me = requireAdmin(c);
    const s = getSettings();
    const r = resolve(s, c.req.param("date"));
    const { proposer, chooser } = await body(c);
    const check = (e: unknown, fallback: string | null) => {
      if (e === null || e === undefined || e === "") return fallback;
      const p = q.participant.get(String(e).toLowerCase());
      if (!p) throw new HttpError(400, "unknown_participant");
      return p.email;
    };
    db.transaction(() => {
      const entry = r.kind === "upcoming" ? claim(s, r.night.index) : r.entry;
      const roles = r.kind === "upcoming" ? r.night.roles : { proposer: entry.proposer_email, chooser: entry.chooser_email };
      db.query("UPDATE lineup SET proposer_email = ?, chooser_email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(check(proposer, roles.proposer), check(chooser, roles.chooser), entry.id);
    })();
    return c.json(stateView(me));
  });

  // ---------- admin: participants & settings ----------

  app.post("/api/participants", async (c) => {
    const me = requireAdmin(c);
    const { email, name, isAdmin } = await body(c);
    const e = String(email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(e)) throw new HttpError(400, "bad_email", "Enter a valid email");
    const existing = q.participant.get(e);
    if (existing) {
      if (existing.active) throw new HttpError(409, "exists", "That person is already a participant");
      db.query("UPDATE participants SET active = 1, position = ? WHERE email = ?").run((q.maxPos.get()?.m ?? -1) + 1, e);
    } else {
      addParticipant(e, String(name ?? "").trim() || defaultName(e), !!isAdmin);
    }
    return c.json(stateView(me));
  });

  app.patch("/api/participants/:email", async (c) => {
    const me = requireMe(c);
    const email = c.req.param("email").toLowerCase();
    const target = q.participant.get(email);
    if (!target) throw new HttpError(404, "unknown_participant");
    const b = await body(c);
    const self = email === me.email;
    if (!me.is_admin && (!self || "active" in b || "isAdmin" in b)) throw new HttpError(403, "forbidden");
    if ("email" in b) {
      if (!me.is_admin) throw new HttpError(403, "forbidden");
      const next = String(b.email ?? "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(next)) throw new HttpError(400, "bad_email", "Enter a valid email");
      if (next !== email) {
        if (self) throw new HttpError(400, "self_email", "You can't change your own email (you'd be signed out)");
        if (q.participant.get(next)) throw new HttpError(409, "exists", "Another participant already has that email");
        db.transaction(() => {
          db.query("UPDATE participants SET email = ? WHERE email = ?").run(next, email);
          db.query("UPDATE lineup SET proposer_email = ? WHERE proposer_email = ?").run(next, email);
          db.query("UPDATE lineup SET chooser_email = ? WHERE chooser_email = ?").run(next, email);
          db.query("UPDATE lineup SET selected_by = ? WHERE selected_by = ?").run(next, email);
          db.query("UPDATE lineup_proposals SET proposed_by = ? WHERE proposed_by = ?").run(next, email);
        })();
        return c.json(stateView(me));
      }
    }
    if ("name" in b) {
      const name = String(b.name ?? "").trim();
      if (!name || name.length > 40) throw new HttpError(400, "bad_name", "Name must be 1 to 40 characters");
      db.query("UPDATE participants SET name = ? WHERE email = ?").run(name, email);
    }
    if ("isAdmin" in b) {
      if (self && !b.isAdmin) throw new HttpError(400, "self_demote", "You can't remove your own admin role");
      db.query("UPDATE participants SET is_admin = ? WHERE email = ?").run(b.isAdmin ? 1 : 0, email);
    }
    if ("active" in b) {
      if (self && !b.active) throw new HttpError(400, "self_remove", "You can't remove yourself");
      db.query("UPDATE participants SET active = ? WHERE email = ?").run(b.active ? 1 : 0, email);
    }
    return c.json(stateView(q.participant.get(me.email)!));
  });

  app.put("/api/participants/order", async (c) => {
    const me = requireAdmin(c);
    const { emails } = await body(c);
    if (!Array.isArray(emails)) throw new HttpError(400, "bad_order");
    const upd = db.query("UPDATE participants SET position = ? WHERE email = ?");
    db.transaction(() => emails.forEach((e: unknown, i: number) => upd.run(i, String(e).toLowerCase())))();
    return c.json(stateView(me));
  });

  app.put("/api/settings", async (c) => {
    const me = requireAdmin(c);
    const b = await body(c);
    const s = getSettings();
    settle(s); // record past nights under the old schedule first
    const updates: [string, string][] = [];
    if ("title" in b) {
      const t = String(b.title ?? "").trim();
      if (!t || t.length > 60) throw new HttpError(400, "bad_title");
      updates.push(["title", t]);
    }
    if ("schedule" in b) {
      const list = Array.isArray(b.schedule) ? b.schedule : [];
      const sched: NightDay[] = list.map((d: any) => ({ weekday: Number(d?.weekday), time: String(d?.time ?? "") }));
      if (!sched.length) throw new HttpError(400, "bad_schedule", "Pick at least one night of the week");
      if (sched.some((d) => !Number.isInteger(d.weekday) || d.weekday < 0 || d.weekday > 6) || new Set(sched.map((d) => d.weekday)).size !== sched.length)
        throw new HttpError(400, "bad_schedule", "Invalid days");
      if (sched.some((d) => !TIME_RE.test(d.time))) throw new HttpError(400, "bad_time", "Pick a start time for each night");
      sched.sort((x, y) => x.weekday - y.weekday);
      updates.push(["schedule", JSON.stringify(sched)]);
    }
    if ("timezone" in b) {
      if (!isValidTimezone(String(b.timezone))) throw new HttpError(400, "bad_timezone", "Unknown timezone");
      updates.push(["timezone", String(b.timezone)]);
    }
    if ("region" in b) {
      const r = String(b.region).toUpperCase();
      if (!/^[A-Z]{2}$/.test(r)) throw new HttpError(400, "bad_region");
      updates.push(["region", r]);
    }
    db.transaction(() => updates.forEach(([k, v]) => q.putSetting.run(k, v)))();
    return c.json(stateView(me));
  });

  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

  return app;
}
