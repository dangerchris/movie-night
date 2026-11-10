import type { Database } from "bun:sqlite";
import { Hono, type Context } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { identify, PICKER_COOKIE, type AuthConfig, type Identity } from "./auth.ts";
import {
  isIsoDate, isValidTimezone, nextWeekday, rotationRoles, todayInTz, upcomingNightDates, weekdayOf,
} from "./schedule.ts";
import { TmdbError, type MovieDetails, type MovieSource } from "./tmdb.ts";

export const PROPOSAL_COUNT = 3;
const MOVIE_CACHE_MS = 7 * 86_400_000;
const UPCOMING_COUNT = 6;
const PAST_COUNT = 12;

export interface AppDeps {
  db: Database;
  auth: AuthConfig;
  movies: MovieSource;
  adminEmails: string[];
  now?: () => Date;
}

interface Participant {
  email: string;
  name: string;
  position: number;
  active: number;
  is_admin: number;
}

interface NightRow {
  date: string;
  proposer_email: string | null;
  chooser_email: string | null;
  selected_tmdb_id: number | null;
  selected_by: string | null;
  selected_at: string | null;
}

interface Settings {
  title: string;
  nightWeekday: number;
  nightTime: string; // HH:MM
  timezone: string;
  region: string;
  rotationAnchor: string;
}

const DEFAULTS: Record<string, string> = {
  title: "Movie Night",
  night_weekday: "6",
  night_time: "19:30",
  timezone: "America/Toronto",
  region: "CA",
};

type Env = { Bindings: object; Variables: { ident: Identity; me: Participant | null } };

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) { super(message ?? code); }
}

/** "Netflix Standard with Ads" -> "Netflix"; "Crave Amazon Channel" -> "Crave (via Prime)", dropped if Crave is listed. */
export function tidyProviders(names: string[]): string[] {
  const base = names.map((n) => n.replace(/\s+(Standard\s+)?with Ads$/i, "").replace(/\s+Amazon Channel$/i, " (via Prime)"));
  const set = new Set(base);
  return [...set].filter((n) => !(n.endsWith(" (via Prime)") && set.has(n.slice(0, -" (via Prime)".length))));
}

export function createApp({ db, auth, movies, adminEmails, now = () => new Date() }: AppDeps) {
  const admins = new Set(adminEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));

  // ---------- data access ----------

  const q = {
    participant: db.query<Participant, [string]>("SELECT * FROM participants WHERE email = ?"),
    participants: db.query<Participant, []>("SELECT * FROM participants ORDER BY active DESC, position, name"),
    activeOrder: db.query<{ email: string }, []>("SELECT email FROM participants WHERE active = 1 ORDER BY position, name"),
    maxPos: db.query<{ m: number | null }, []>("SELECT MAX(position) AS m FROM participants"),
    night: db.query<NightRow, [string]>("SELECT * FROM nights WHERE date = ?"),
    nightsFrom: db.query<NightRow, [string]>("SELECT * FROM nights WHERE date >= ? ORDER BY date"),
    pastNights: db.query<NightRow, [string, number]>(
      `SELECT n.* FROM nights n WHERE n.date < ?
         AND (n.selected_tmdb_id IS NOT NULL OR EXISTS (SELECT 1 FROM proposals p WHERE p.night_date = n.date))
       ORDER BY n.date DESC LIMIT ?`),
    proposals: db.query<{ slot: number; tmdb_id: number; proposed_by: string | null }, [string]>(
      "SELECT slot, tmdb_id, proposed_by FROM proposals WHERE night_date = ? ORDER BY slot"),
    cachedMovie: db.query<{ data: string; fetched_at: number }, [number]>("SELECT data, fetched_at FROM movies WHERE tmdb_id = ?"),
    putMovie: db.query("INSERT OR REPLACE INTO movies (tmdb_id, data, fetched_at) VALUES (?, ?, ?)"),
    settingRows: db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings"),
    putSetting: db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"),
    ensureNight: db.query("INSERT OR IGNORE INTO nights (date) VALUES (?)"),
  };

  function getSettings(): Settings {
    const raw: Record<string, string> = { ...DEFAULTS };
    for (const r of q.settingRows.all()) raw[r.key] = r.value;
    const weekday = Number(raw.night_weekday);
    if (!raw.rotation_anchor) {
      raw.rotation_anchor = nextWeekday(todayInTz(raw.timezone, now()), weekday);
      q.putSetting.run("rotation_anchor", raw.rotation_anchor);
    }
    return {
      title: raw.title, nightWeekday: weekday, nightTime: raw.night_time, timezone: raw.timezone,
      region: raw.region, rotationAnchor: raw.rotation_anchor,
    };
  }

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

  /** Effective roles: stored override, else the rotation. */
  function rolesFor(date: string, s: Settings, row: NightRow | null) {
    const order = q.activeOrder.all().map((p) => p.email);
    const rot = rotationRoles(date, s.rotationAnchor, order);
    return { proposer: row?.proposer_email ?? rot.proposer, chooser: row?.chooser_email ?? rot.chooser };
  }

  function isNightDate(date: string, s: Settings): boolean {
    return weekdayOf(date) === s.nightWeekday || q.night.get(date) !== null;
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

  function nightView(date: string, s: Settings, today: string, me: Participant, names: Map<string, string>) {
    const row = q.night.get(date);
    const roles = rolesFor(date, s, row);
    const proposals = q.proposals.all(date).map((p) => movieView(cachedMovie(p.tmdb_id), s.region));
    const selectedId = row?.selected_tmdb_id ?? null;
    const isPast = date < today;
    const admin = !!me.is_admin;
    const full = proposals.length === PROPOSAL_COUNT;
    return {
      date,
      time: s.nightTime,
      isPast,
      isToday: date === today,
      proposer: personView(roles.proposer, names),
      chooser: personView(roles.chooser, names),
      proposals,
      selectedId,
      selectedBy: personView(row?.selected_by ?? null, names),
      rolesOverridden: !!(row?.proposer_email || row?.chooser_email),
      // What you can do because you hold the role. Admins can do both at any time (see canOverride).
      canPropose: roles.proposer === me.email && !isPast && selectedId === null,
      canChoose: roles.chooser === me.email && full && !isPast,
      canOverride: admin,
    };
  }

  function stateView(me: Participant) {
    const s = getSettings();
    const today = todayInTz(s.timezone, now());
    const all = q.participants.all();
    const names = new Map(all.map((p) => [p.email, p.name]));
    const dates = new Set(upcomingNightDates(today, s.nightWeekday, UPCOMING_COUNT));
    for (const r of q.nightsFrom.all(today)) dates.add(r.date); // off-schedule nights with data
    const upcoming = [...dates].sort().map((d) => nightView(d, s, today, me, names));
    const past = q.pastNights.all(today, PAST_COUNT).map((r) => nightView(r.date, s, today, me, names));
    return {
      settings: s,
      today,
      me: participantView(me),
      participants: all.map(participantView),
      upcoming,
      past,
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

  app.get("/api/search", async (c) => {
    requireMe(c);
    const query = (c.req.query("q") ?? "").trim();
    if (query.length < 2) return c.json({ results: [] });
    return c.json({ results: await movies.search(query) });
  });

  app.get("/api/movie/:id", async (c) => {
    requireMe(c);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "bad_id");
    return c.json(movieView(await getMovie(id), getSettings().region));
  });

  const nightDate = (c: Context<Env>, s: Settings) => {
    const date = c.req.param("date") ?? "";
    if (!isIsoDate(date) || !isNightDate(date, s)) throw new HttpError(404, "not_a_night", "That date is not a movie night");
    return date;
  };

  app.put("/api/nights/:date/proposals", async (c) => {
    const me = requireMe(c);
    const s = getSettings();
    const date = nightDate(c, s);
    const today = todayInTz(s.timezone, now());
    const row = q.night.get(date);
    const roles = rolesFor(date, s, row);
    const admin = !!me.is_admin;
    if (roles.proposer !== me.email && !admin) throw new HttpError(403, "not_proposer", "You are not the proposer for this night");
    if (date < today && !admin) throw new HttpError(409, "past", "That night has passed");
    if (row?.selected_tmdb_id && !admin) throw new HttpError(409, "already_selected", "A movie has already been picked");

    const { tmdbIds } = await body(c);
    const ids = Array.isArray(tmdbIds) ? tmdbIds.map(Number) : [];
    if (ids.length !== PROPOSAL_COUNT || ids.some((n) => !Number.isInteger(n) || n <= 0) || new Set(ids).size !== ids.length)
      throw new HttpError(400, "bad_proposals", `Pick ${PROPOSAL_COUNT} different movies`);
    await Promise.all(ids.map((id) => getMovie(id))); // validates ids and warms the cache

    db.transaction(() => {
      q.ensureNight.run(date);
      // Freeze the roles so later roster changes don't rewrite this night.
      db.query("UPDATE nights SET proposer_email = ?, chooser_email = ?, updated_at = CURRENT_TIMESTAMP WHERE date = ?")
        .run(roles.proposer, roles.chooser, date);
      db.query("DELETE FROM proposals WHERE night_date = ?").run(date);
      const ins = db.query("INSERT INTO proposals (night_date, slot, tmdb_id, proposed_by) VALUES (?, ?, ?, ?)");
      ids.forEach((id, slot) => ins.run(date, slot, id, me.email));
      if (row?.selected_tmdb_id && !ids.includes(row.selected_tmdb_id))
        db.query("UPDATE nights SET selected_tmdb_id = NULL, selected_by = NULL, selected_at = NULL WHERE date = ?").run(date);
    })();
    return c.json(stateView(me));
  });

  app.put("/api/nights/:date/selection", async (c) => {
    const me = requireMe(c);
    const s = getSettings();
    const date = nightDate(c, s);
    const today = todayInTz(s.timezone, now());
    const row = q.night.get(date);
    const roles = rolesFor(date, s, row);
    const admin = !!me.is_admin;
    if (roles.chooser !== me.email && !admin) throw new HttpError(403, "not_chooser", "You are not the chooser for this night");
    if (date < today && !admin) throw new HttpError(409, "past", "That night has passed");
    const proposed = q.proposals.all(date).map((p) => p.tmdb_id);
    if (proposed.length !== PROPOSAL_COUNT) throw new HttpError(409, "no_proposals", "The proposer hasn't set the movies yet");

    const { tmdbId } = await body(c);
    if (tmdbId === null) {
      db.query("UPDATE nights SET selected_tmdb_id = NULL, selected_by = NULL, selected_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE date = ?").run(date);
    } else {
      const id = Number(tmdbId);
      if (!proposed.includes(id)) throw new HttpError(400, "not_proposed", "That movie wasn't one of the choices");
      db.query("UPDATE nights SET selected_tmdb_id = ?, selected_by = ?, selected_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE date = ?")
        .run(id, me.email, date);
    }
    return c.json(stateView(me));
  });

  app.put("/api/nights/:date/roles", async (c) => {
    const me = requireAdmin(c);
    const s = getSettings();
    const date = nightDate(c, s);
    const { proposer, chooser } = await body(c);
    const check = (e: unknown) => {
      if (e === null || e === undefined || e === "") return null;
      const p = q.participant.get(String(e).toLowerCase());
      if (!p) throw new HttpError(400, "unknown_participant");
      return p.email;
    };
    const p = check(proposer), ch = check(chooser);
    db.transaction(() => {
      q.ensureNight.run(date);
      db.query("UPDATE nights SET proposer_email = ?, chooser_email = ?, updated_at = CURRENT_TIMESTAMP WHERE date = ?").run(p, ch, date);
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
    const updates: [string, string][] = [];
    if ("title" in b) {
      const t = String(b.title ?? "").trim();
      if (!t || t.length > 60) throw new HttpError(400, "bad_title");
      updates.push(["title", t]);
    }
    if ("nightWeekday" in b) {
      const w = Number(b.nightWeekday);
      if (!Number.isInteger(w) || w < 0 || w > 6) throw new HttpError(400, "bad_weekday");
      if (w !== s.nightWeekday) {
        updates.push(["night_weekday", String(w)]);
        // Keep the rotation continuous: the next night under the new weekday keeps the
        // same rotation slot as the next night under the old one.
        const today = todayInTz(s.timezone, now());
        const oldNext = nextWeekday(today, s.nightWeekday);
        const newNext = nextWeekday(today, w);
        const shift = Math.round((Date.parse(newNext) - Date.parse(oldNext)) / 86_400_000);
        updates.push(["rotation_anchor", new Date(Date.parse(s.rotationAnchor) + shift * 86_400_000).toISOString().slice(0, 10)]);
      }
    }
    if ("nightTime" in b) {
      const t = String(b.nightTime);
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new HttpError(400, "bad_time");
      updates.push(["night_time", t]);
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
