import { describe, expect, test } from "bun:test";
import { createApp, tidyProviders } from "./app.ts";
import { openDb } from "./db.ts";
import { nightsBetween, rotationRoles, upcomingNightDates } from "./schedule.ts";
import type { MovieSource } from "./tmdb.ts";

const fakeMovies: MovieSource = {
  async search(q) { return [1, 2].map((id) => ({ id, title: q, year: "2000", posterPath: null, overview: "", rating: 7 })); },
  async details(id) {
    if (id === 404) throw Object.assign(new Error("nope"), { status: 404 });
    return {
      id, title: `Movie ${id}`, originalTitle: null, year: "2001", releaseDate: "2001-01-01", posterPath: "/p.jpg",
      backdropPath: null, tagline: null, overview: "A thing happens.", runtime: 100, genres: ["Drama"], rating: 7.5,
      voteCount: 10, certifications: { US: "PG-13", CA: "PG" }, providers: { CA: ["Crave"] }, trailerKey: "abc", directors: ["Dee Rector"], cast: [{ name: "Ac Tor", character: "Hero" }], imdbId: null,
    };
  },
};

// Tuesday 2026-11-10, noon UTC. Next Saturday is 2026-11-14.
function setup(library: any = null, notifier: any = null) {
  const clock = { now: new Date("2026-11-10T17:00:00Z") };
  const app = createApp({
    library,
    notifier,
    db: openDb(":memory:"), movies: fakeMovies, adminEmails: [],
    auth: { accessTeamDomain: "", accessAud: "", picker: "localhost", publicUrl: "https://movies.example" },
    now: () => clock.now,
  });
  const peer = (address: string) => ({ requestIP: () => ({ address }) });
  const call = async (as: string | null, method: string, path: string, body?: unknown, from = "127.0.0.1") => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (as) headers.cookie = `mn_user=${as}`;
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, peer(from));
    return { status: res.status, json: (await res.json()) as any };
  };
  const setDay = (iso: string, utcTime = "17:00") => { clock.now = new Date(`${iso}T${utcTime}:00Z`); };
  return { app, call, peer, setDay };
}

describe("schedule", () => {
  test("upcoming dates land on the scheduled weekdays", () => {
    expect(upcomingNightDates("2026-11-10", [6], 0, 3)).toEqual(["2026-11-14", "2026-11-21", "2026-11-28"]);
    expect(upcomingNightDates("2026-11-14", [6], 0, 1)).toEqual(["2026-11-14"]);
    expect(upcomingNightDates("2026-11-10", [1, 6], 14, 1)).toEqual(["2026-11-14", "2026-11-16", "2026-11-21", "2026-11-23"]);
  });

  test("nightsBetween counts scheduled nights, signed", () => {
    expect(nightsBetween("2026-11-14", "2026-11-14", [1, 6])).toBe(0);
    expect(nightsBetween("2026-11-14", "2026-11-16", [1, 6])).toBe(1);
    expect(nightsBetween("2026-11-14", "2026-11-21", [1, 6])).toBe(2);
    expect(nightsBetween("2026-11-14", "2026-12-14", [1, 6])).toBe(9); // 5 Saturdays + 4 Mondays
    expect(nightsBetween("2026-11-14", "2026-11-09", [1, 6])).toBe(-1); // Mon Nov 9 is the night before
    expect(nightsBetween("2026-11-14", "2026-12-05", [6])).toBe(3);
  });

  test("rotation for three people", () => {
    const order = ["a", "b", "c"];
    const pairs = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => { const r = rotationRoles(from + i, order); return `${r.proposer}${r.chooser}`; });
    expect(pairs(0, 6)).toEqual(["ab", "bc", "ca", "ac", "cb", "ba"]);
    expect(pairs(6, 12)).toEqual(pairs(0, 6));
    expect(pairs(-6, 0)).toEqual(pairs(0, 6));
  });

  for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    test(`rotation invariants for ${n} people`, () => {
      const order = Array.from({ length: n }, (_, i) => `p${i}`);
      const len = n * (n - 1);
      const weeks = Array.from({ length: len * 2 }, (_, k) => rotationRoles(k, order));
      const seen = new Set<string>();
      weeks.slice(0, len).forEach((w) => seen.add(`${w.proposer}>${w.chooser}`));
      expect(seen.size).toBe(len); // every pairing once per cycle
      for (let k = 0; k < weeks.length; k++) {
        const w = weeks[k];
        expect(w.chooser).not.toBe(w.proposer);
        if (k > 0) {
          expect(w.proposer).not.toBe(weeks[k - 1].proposer);
          expect(w.chooser).not.toBe(weeks[k - 1].chooser);
          if (n >= 4) expect(w.proposer).not.toBe(weeks[k - 1].chooser);
        }
      }
      for (let r = 0; r < len / n; r++) { // each round: everyone proposes once and chooses once
        const round = weeks.slice(r * n, r * n + n);
        expect(new Set(round.map((w) => w.proposer)).size).toBe(n);
        expect(new Set(round.map((w) => w.chooser)).size).toBe(n);
      }
    });
  }
});

describe("api", () => {
  test("setup, picker and full propose/choose flow", async () => {
    const { call } = setup();
    let r = await call(null, "GET", "/api/me");
    expect(r.json).toMatchObject({ mode: "picker", needsSetup: true, me: null });

    r = await call(null, "POST", "/api/setup", { email: "Alice@x.com", name: "Alice" });
    expect(r.status).toBe(200);
    r = await call(null, "POST", "/api/setup", { email: "eve@x.com" });
    expect(r.status).toBe(409);

    r = await call("alice@x.com", "POST", "/api/participants", { email: "bob@x.com", name: "Bob" });
    expect(r.status).toBe(200);
    r = await call("alice@x.com", "POST", "/api/participants", { email: "cat@x.com", name: "Cat" });

    r = await call("bob@x.com", "GET", "/api/state");
    const next = r.json.upcoming[0];
    expect(next.date).toBe("2026-11-14");
    expect(next.proposer.name).toBe("Alice");
    expect(next.chooser.name).toBe("Bob");
    expect(r.json.upcoming[1].proposer.name).toBe("Bob");
    expect(next.canPropose).toBe(false);

    // Bob can't propose for Alice's night; can't choose before proposals exist.
    expect((await call("bob@x.com", "PUT", "/api/nights/2026-11-14/proposals", { tmdbIds: [1, 2, 3] })).status).toBe(403);
    expect((await call("bob@x.com", "PUT", "/api/nights/2026-11-14/selection", { tmdbId: 1 })).status).toBe(409);
    // Not a night.
    expect((await call("alice@x.com", "PUT", "/api/nights/2026-11-13/proposals", { tmdbIds: [1, 2, 3] })).status).toBe(404);
    // Need exactly 3 distinct.
    expect((await call("alice@x.com", "PUT", "/api/nights/2026-11-14/proposals", { tmdbIds: [1, 1, 2] })).status).toBe(400);

    r = await call("alice@x.com", "PUT", "/api/nights/2026-11-14/proposals", { tmdbIds: [10, 20, 30] });
    expect(r.status).toBe(200);
    expect(r.json.upcoming[0].proposals.map((m: any) => m.title)).toEqual(["Movie 10", "Movie 20", "Movie 30"]);
    expect(r.json.upcoming[0].proposals[0].certification).toBe("PG"); // default region CA

    r = await call("alice@x.com", "GET", "/api/state");
    expect(r.json.upcoming[0]).toMatchObject({ canChoose: false, canOverride: true }); // admin, not chooser
    r = await call("bob@x.com", "GET", "/api/state");
    expect(r.json.upcoming[0]).toMatchObject({ canChoose: true, canOverride: false });
    // Cat can't choose; Bob can, only among the proposals.
    expect((await call("cat@x.com", "PUT", "/api/nights/2026-11-14/selection", { tmdbId: 20 })).status).toBe(403);
    expect((await call("bob@x.com", "PUT", "/api/nights/2026-11-14/selection", { tmdbId: 99 })).status).toBe(400);
    r = await call("bob@x.com", "PUT", "/api/nights/2026-11-14/selection", { tmdbId: 20 });
    expect(r.json.upcoming[0].selectedId).toBe(20);
    expect(r.json.upcoming[0].selectedBy.name).toBe("Bob");

    // Proposer locked out after the pick; roles are frozen against roster changes.
    r = await call("bob@x.com", "GET", "/api/state");
    expect(r.json.upcoming[0].canPropose).toBe(false);
    await call("alice@x.com", "PUT", "/api/participants/order", { emails: ["cat@x.com", "bob@x.com", "alice@x.com"] });
    r = await call("bob@x.com", "GET", "/api/state");
    expect(r.json.upcoming[0].proposer.name).toBe("Alice");
    expect(r.json.upcoming[1].proposer.name).toBe("Bob"); // week 1 of new order [cat, bob, alice]
  });

  test("recurring schedule: several nights a week, per-day times, rotation advances per night", async () => {
    const { call } = setup();
    await call(null, "POST", "/api/setup", { email: "a@x.com", name: "A" });
    await call("a@x.com", "POST", "/api/participants", { email: "b@x.com", name: "B" });
    await call("a@x.com", "POST", "/api/participants", { email: "c@x.com", name: "C" });
    let r = await call("a@x.com", "GET", "/api/state"); // Saturdays only, anchor 2026-11-14
    expect(r.json.settings.schedule).toEqual([{ weekday: 6, time: "19:30" }]);
    expect((await call("a@x.com", "PUT", "/api/settings", { schedule: [] })).status).toBe(400);
    expect((await call("a@x.com", "PUT", "/api/settings", { schedule: [{ weekday: 1, time: "25:00" }] })).status).toBe(400);

    r = await call("a@x.com", "PUT", "/api/settings", { schedule: [{ weekday: 6, time: "19:30" }, { weekday: 1, time: "20:00" }] });
    const nights = r.json.upcoming;
    expect(nights.slice(0, 4).map((n: any) => `${n.on} ${n.time}`))
      .toEqual(["2026-11-14 19:30", "2026-11-16 20:00", "2026-11-21 19:30", "2026-11-23 20:00"]);
    // Nothing locked: the next night keeps its roles, and consecutive nights never repeat a role.
    expect(nights[0].proposer.name).toBe("A");
    expect(nights[0].chooser.name).toBe("B");
    for (let i = 1; i < nights.length; i++) {
      expect(nights[i].proposer.email).not.toBe(nights[i - 1].proposer.email);
      expect(nights[i].chooser.email).not.toBe(nights[i - 1].chooser.email);
    }
    // Monday nights are real nights.
    expect((await call("a@x.com", "PUT", "/api/nights/2026-11-16/schedule", { time: "21:00" })).json.upcoming[1].time).toBe("21:00");
    // Changing only a time keeps the rotation where it is.
    const before = r.json.upcoming.map((n: any) => n.proposer.email);
    r = await call("a@x.com", "PUT", "/api/settings", { schedule: [{ weekday: 6, time: "18:00" }, { weekday: 1, time: "20:00" }] });
    expect(r.json.upcoming.map((n: any) => n.proposer.email)).toEqual(before);
    expect(r.json.upcoming[0].time).toBe("18:00");
  });

  const three = async (call: any) => {
    await call(null, "POST", "/api/setup", { email: "a@x.com", name: "A" });
    await call("a@x.com", "POST", "/api/participants", { email: "b@x.com", name: "B" });
    await call("a@x.com", "POST", "/api/participants", { email: "c@x.com", name: "C" });
  };
  const MON_SAT = { schedule: [{ weekday: 1, time: "20:00" }, { weekday: 6, time: "19:30" }] };
  const brief = (st: any) => st.upcoming.map((n: any) => `${n.date} ${n.proposer.name}>${n.chooser.name}${n.inLineup ? "*" : ""}`);

  test("the lineup fills the schedule in order with no gaps when nights are added", async () => {
    const { call } = setup();
    await three(call);
    await call("a@x.com", "PUT", "/api/nights/2026-11-14/proposals", { tmdbIds: [1, 2, 3] });
    await call("a@x.com", "PUT", "/api/nights/2026-11-21/proposals", { tmdbIds: [4, 5, 6] });
    await call("a@x.com", "PUT", "/api/nights/2026-12-05/proposals", { tmdbIds: [7, 8, 9] }); // Nov 28 joins the lineup too
    let r = await call("a@x.com", "GET", "/api/state");
    const before = brief(r.json).slice(0, 4).map((x: string) => x.slice(11));
    expect(brief(r.json).slice(0, 4).map((x: string) => x.slice(0, 10))).toEqual(["2026-11-14", "2026-11-21", "2026-11-28", "2026-12-05"]);
    expect(r.json.upcoming[2].inLineup).toBe(true);
    expect(r.json.upcoming[2].proposals).toEqual([]);

    r = await call("a@x.com", "PUT", "/api/settings", MON_SAT);
    // Same nights, same order, same roles and choices; now on the next four dates.
    expect(brief(r.json).slice(0, 4)).toEqual(
      ["2026-11-14", "2026-11-16", "2026-11-21", "2026-11-23"].map((d, i) => `${d} ${before[i]}`));
    expect(r.json.upcoming[1].proposals.map((m: any) => m.id)).toEqual([4, 5, 6]);
    expect(r.json.upcoming[3].proposals.map((m: any) => m.id)).toEqual([7, 8, 9]);
    expect(r.json.upcoming[1].time).toBe("20:00");
    // Open nights continue after the lineup without back-to-back repeats.
    const n = r.json.upcoming;
    for (let i = 1; i < n.length; i++) {
      expect(n[i].proposer.email).not.toBe(n[i - 1].proposer.email);
      expect(n[i].chooser.email).not.toBe(n[i - 1].chooser.email);
    }
  });

  test("proposing ahead keeps every night's roles as shown", async () => {
    const { call } = setup();
    await three(call);
    let r = await call("a@x.com", "PUT", "/api/settings", MON_SAT);
    const shown = brief(r.json).map((x: string) => x.replace("*", ""));
    const night = r.json.upcoming[3];
    r = await call(night.proposer.email, "PUT", `/api/nights/${night.date}/proposals`, { tmdbIds: [1, 2, 3] });
    expect(r.status).toBe(200);
    expect(brief(r.json).map((x: string) => x.replace("*", ""))).toEqual(shown);
    expect(r.json.upcoming.slice(0, 4).every((x: any) => x.inLineup)).toBe(true);
    expect(r.json.upcoming[4].inLineup).toBe(false);
  });

  test("changing a night's date moves it; the nights after close up; it can go back", async () => {
    const { call } = setup();
    await three(call);
    await call("a@x.com", "PUT", "/api/settings", MON_SAT);
    for (const d of ["2026-11-14", "2026-11-16", "2026-11-21"]) {
      const st = (await call("a@x.com", "GET", "/api/state")).json;
      const n = st.upcoming.find((x: any) => x.date === d);
      await call(n.proposer.email, "PUT", `/api/nights/${d}/proposals`, { tmdbIds: [n.date.length, 2, 3].map((x, i) => x + i * 10 + Number(d.slice(8))) });
    }
    let r = await call("a@x.com", "GET", "/api/state");
    const [e1, e2, e3] = r.json.upcoming.slice(0, 3).map((n: any) => n.proposals[0].id);
    expect((await call("b@x.com", "PUT", "/api/nights/2026-11-14/schedule", { on: "2026-11-20" })).status).toBe(403);
    expect((await call("a@x.com", "PUT", "/api/nights/2026-11-14/schedule", { on: "2026-11-21" })).status).toBe(409);
    // Sat Nov 14 -> Fri Nov 20 at 21:00.
    r = await call("a@x.com", "PUT", "/api/nights/2026-11-14/schedule", { on: "2026-11-20", time: "21:00" });
    expect(r.status).toBe(200);
    const by = (st: any) => st.upcoming.slice(0, 3).map((n: any) => `${n.date} ${n.proposals[0]?.id}`);
    expect(by(r.json)).toEqual([`2026-11-16 ${e2}`, `2026-11-20 ${e1}`, `2026-11-21 ${e3}`]);
    expect(r.json.upcoming[1]).toMatchObject({ time: "21:00", movedFrom: "2026-11-14", extra: true });
    // Back to the regular schedule.
    r = await call("a@x.com", "PUT", "/api/nights/2026-11-20/schedule", { on: null, time: null });
    expect(by(r.json)).toEqual([`2026-11-14 ${e1}`, `2026-11-16 ${e2}`, `2026-11-21 ${e3}`]);
    expect(r.json.upcoming[0]).toMatchObject({ time: "19:30", movedFrom: null });
    // Time only.
    r = await call("a@x.com", "PUT", "/api/nights/2026-11-16/schedule", { time: "18:45" });
    expect(r.json.upcoming[1]).toMatchObject({ date: "2026-11-16", time: "18:45", customTime: true });
  });

  test("skipping a date moves the nights after it up; restoring puts it back", async () => {
    const { call } = setup();
    await three(call);
    await call("a@x.com", "PUT", "/api/settings", MON_SAT);
    const first = (await call("a@x.com", "GET", "/api/state")).json.upcoming[0];
    await call(first.proposer.email, "PUT", "/api/nights/2026-11-14/proposals", { tmdbIds: [1, 2, 3] });
    let r = await call("a@x.com", "PUT", "/api/nights/2026-11-14/skip", {});
    expect(r.json.upcoming[0]).toMatchObject({ date: "2026-11-16", proposer: { email: first.proposer.email } });
    expect(r.json.upcoming[0].proposals.map((m: any) => m.id)).toEqual([1, 2, 3]);
    expect(r.json.skipped).toEqual(["2026-11-14"]);
    r = await call("a@x.com", "DELETE", "/api/skipped/2026-11-14");
    expect(r.json.upcoming[0]).toMatchObject({ date: "2026-11-14" });
    expect(r.json.skipped).toEqual([]);
  });

  test("nights settle on their dates as time passes; the rotation carries on", async () => {
    const { call, setDay } = setup();
    await three(call);
    await call("a@x.com", "PUT", "/api/settings", MON_SAT);
    let st = (await call("a@x.com", "GET", "/api/state")).json;
    const [n1, n2] = st.upcoming;
    await call(n1.proposer.email, "PUT", `/api/nights/${n1.date}/proposals`, { tmdbIds: [1, 2, 3] });
    await call(n1.chooser.email, "PUT", `/api/nights/${n1.date}/selection`, { tmdbId: 2 });
    setDay("2026-11-15");
    st = (await call("a@x.com", "GET", "/api/state")).json;
    expect(st.past.map((n: any) => [n.date, n.selectedId])).toEqual([["2026-11-14", 2]]);
    expect(st.upcoming[0]).toMatchObject({ date: "2026-11-16", proposer: { email: n2.proposer.email }, chooser: { email: n2.chooser.email } });
    // Monday passes with nothing proposed: that turn carries over to the next night.
    setDay("2026-11-17");
    st = (await call("a@x.com", "GET", "/api/state")).json;
    expect(st.upcoming[0]).toMatchObject({ date: "2026-11-21", proposer: { email: n2.proposer.email } });
    // A past night's date can be corrected.
    const r = await call("a@x.com", "PUT", "/api/nights/2026-11-14/schedule", { on: "2026-11-13" });
    expect(r.json.past[0].date).toBe("2026-11-13");
  });

  test("chat notifications: turns, picks and once-only reminders with mentions", async () => {
    const sent: { text: string; html: string; mentions: string[] }[] = [];
    const notifier = { async send(text: string, html: string, mentions: string[]) { sent.push({ text, html, mentions }); } };
    const { app, call, setDay } = setup(null, notifier);
    await three(call);
    await call("a@x.com", "PATCH", "/api/participants/b%40x.com", { matrixId: "@bee:chat" });
    expect((await call("a@x.com", "PATCH", "/api/participants/c%40x.com", { matrixId: "nope" })).status).toBe(400);
    const flush = () => new Promise((r) => setTimeout(r, 0));
    let st = (await call("a@x.com", "GET", "/api/state")).json;
    const n1 = st.upcoming[0]; // Sat Nov 14, A proposes, B chooses
    expect([n1.proposer.name, n1.chooser.name]).toEqual(["A", "B"]);

    // Two days before at 10:00 Toronto (15:00 UTC): proposer reminder, once.
    setDay("2026-11-12", "14:00");
    await app.runReminders();
    expect(sent).toHaveLength(0);
    setDay("2026-11-12", "15:05");
    await app.runReminders();
    await app.runReminders();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("A, you're proposing for movie night on Sat, Nov 14 at 7:30 PM");
    expect(sent[0].mentions).toEqual(["@bee:chat"]); // B (the chooser) has a Matrix ID; A doesn't
    expect(sent[0].html).toContain('<a href="https://matrix.to/#/@bee:chat">B</a>');

    // Proposals: the chooser is told it's their turn.
    await call("a@x.com", "PUT", "/api/nights/2026-11-14/proposals", { tmdbIds: [1, 2, 3] });
    await flush();
    expect(sent[1].text).toContain("B, your turn to pick for Sat, Nov 14 at 7:30 PM: Movie 1, Movie 2 or Movie 3. Proposed by A.");
    expect(sent[1].mentions).toEqual(["@bee:chat"]);
    // Day of, nothing picked yet: chooser reminder.
    setDay("2026-11-14", "15:10");
    await app.runReminders();
    expect(sent[2].text).toContain("B, movie night is tonight at 7:30 PM. Time to pick: Movie 1, Movie 2 or Movie 3.");
    // Pick, then the noon "tonight" note, once.
    await call("b@x.com", "PUT", "/api/nights/2026-11-14/selection", { tmdbId: 2 });
    await flush();
    expect(sent[3].text).toContain("B picked Movie 2 for Sat, Nov 14 at 7:30 PM.");
    setDay("2026-11-14", "17:05");
    await app.runReminders();
    await app.runReminders();
    expect(sent[4].text).toContain("Tonight at 7:30 PM: Movie 2, picked by B.");
    expect(sent).toHaveLength(5);
    // After the night starts, nothing more for it.
    setDay("2026-11-15", "01:00"); // 8pm Toronto
    await app.runReminders();
    expect(sent).toHaveLength(5);
  });

  test("runs of open nights between locked nights are planned without repeats when possible", async () => {
    const { call } = setup();
    await call(null, "POST", "/api/setup", { email: "a@x.com", name: "A" });
    await call("a@x.com", "POST", "/api/participants", { email: "b@x.com", name: "B" });
    await call("a@x.com", "POST", "/api/participants", { email: "c@x.com", name: "C" });
    await call("a@x.com", "PUT", "/api/nights/2026-11-14/proposals", { tmdbIds: [1, 2, 3] }); // A -> B
    await call("a@x.com", "PUT", "/api/nights/2026-11-21/proposals", { tmdbIds: [4, 5, 6] }); // B -> C
    await call("a@x.com", "PUT", "/api/nights/2026-12-05/roles", { proposer: "a@x.com", chooser: "c@x.com" });
    const r = await call("a@x.com", "PUT", "/api/settings", { schedule: [{ weekday: 1, time: "19:30" }, { weekday: 6, time: "19:30" }] });
    const n = r.json.upcoming.filter((x: any) => x.on <= "2026-12-05");
    expect(n.map((x: any) => x.on)).toEqual(["2026-11-14", "2026-11-16", "2026-11-21", "2026-11-23", "2026-11-28", "2026-11-30", "2026-12-05"]);
    for (let i = 1; i < n.length; i++) {
      expect(n[i].proposer.email).not.toBe(n[i - 1].proposer.email);
      expect(n[i].chooser.email).not.toBe(n[i - 1].chooser.email);
    }
    // Planned roles are stable: proposing for an open night with its planned roles changes nothing else.
    const mon23 = n[3];
    const r2 = await call(mon23.proposer.email, "PUT", "/api/nights/2026-11-23/proposals", { tmdbIds: [7, 8, 9] });
    expect(r2.status).toBe(200);
    expect(r2.json.upcoming.map((x: any) => `${x.on}:${x.proposer.email}>${x.chooser.email}`))
      .toEqual(r.json.upcoming.map((x: any) => `${x.on}:${x.proposer.email}>${x.chooser.email}`));
  });

  test("tunnel requests without Access config are denied", async () => {
    const { app, peer } = setup();
    const res = await app.request("/api/state", { headers: { "cf-ray": "abc", cookie: "mn_user=a@x.com" } }, peer("127.0.0.1"));
    expect(res.status).toBe(401);
  });

  test("picker is localhost-only: LAN clients can't impersonate", async () => {
    const { app, call } = setup();
    await call(null, "POST", "/api/setup", { email: "a@x.com", name: "A" });
    expect((await call("a@x.com", "GET", "/api/state")).status).toBe(200);
    const lan = await call("a@x.com", "GET", "/api/state", undefined, "192.168.1.50");
    expect(lan.status).toBe(401);
    expect(lan.json.message).toContain("https://movies.example");
    expect((await call(null, "GET", "/api/me", undefined, "192.168.1.50")).json.mode).toBe("denied");
    expect((await call(null, "POST", "/api/picker", { email: "a@x.com" }, "192.168.1.50")).status).toBe(403);
    // Unknown peer address never counts as localhost.
    expect((await app.request("/api/state", { headers: { cookie: "mn_user=a@x.com" } })).status).toBe(401);
  });

  test("changing an email carries locked roles; removing someone unlocks their upcoming role", async () => {
    const { call } = setup();
    await call(null, "POST", "/api/setup", { email: "a@x.com", name: "A" });
    await call("a@x.com", "POST", "/api/participants", { email: "b@x.com", name: "B" });
    await call("a@x.com", "POST", "/api/participants", { email: "c@x.com", name: "C" });
    await call("a@x.com", "PUT", "/api/nights/2026-11-14/proposals", { tmdbIds: [1, 2, 3] });
    let r = await call("a@x.com", "PATCH", "/api/participants/b%40x.com", { email: "bee@x.com" });
    expect(r.json.upcoming[0].chooser.email).toBe("bee@x.com");
    expect((await call("bee@x.com", "PUT", "/api/nights/2026-11-14/selection", { tmdbId: 2 })).status).toBe(200);
    expect((await call("a@x.com", "PATCH", "/api/participants/c%40x.com", { email: "bee@x.com" })).status).toBe(409);
    expect((await call("a@x.com", "PATCH", "/api/participants/a%40x.com", { email: "z@x.com" })).status).toBe(400);

    await call("a@x.com", "PUT", "/api/nights/2026-11-21/proposals", { tmdbIds: [4, 5, 6] }); // admin; locks bee -> c
    r = await call("a@x.com", "PATCH", "/api/participants/c%40x.com", { active: false });
    const n21 = r.json.upcoming.find((n: any) => n.date === "2026-11-21");
    expect(n21.proposer.email).toBe("bee@x.com");
    expect(n21.chooser.email).not.toBe("c@x.com");
  });

  test("proposal history lists passed-over movies from settled nights; search marks watched", async () => {
    const { call } = setup();
    await call(null, "POST", "/api/setup", { email: "a@x.com", name: "A" });
    await call("a@x.com", "PUT", "/api/nights/2026-11-14/proposals", { tmdbIds: [1, 2, 3] });
    await call("a@x.com", "PUT", "/api/nights/2026-11-14/selection", { tmdbId: 2 });
    await call("a@x.com", "PUT", "/api/nights/2026-11-21/proposals", { tmdbIds: [3, 4, 5] });
    // Nov 21 is still waiting for a pick, so its movies aren't offered yet.
    let r = await call("a@x.com", "GET", "/api/proposal-history?exclude=2026-11-28");
    expect(r.json.movies.map((m: any) => m.id)).toEqual([1, 3]);
    expect(r.json.movies[1]).toMatchObject({ lastProposed: "2026-11-14", proposedBy: "A" });
    // Once Nov 21 is picked, its other two join the list (newest first; 3 deduped; picked ones never listed).
    await call("a@x.com", "PUT", "/api/nights/2026-11-21/selection", { tmdbId: 4 });
    r = await call("a@x.com", "GET", "/api/proposal-history?exclude=2026-11-28");
    expect(r.json.movies.map((m: any) => m.id)).toEqual([3, 5, 1]);
    expect(r.json.movies[0]).toMatchObject({ lastProposed: "2026-11-21", passedOver: 2 });
    // A past night with no pick counts as settled too.
    await call("a@x.com", "PUT", "/api/nights/2026-11-28/proposals", { tmdbIds: [6, 7, 8] });
    await call("a@x.com", "PUT", "/api/nights/2026-11-28/schedule", { on: "2026-11-09" });
    r = await call("a@x.com", "GET", "/api/proposal-history?exclude=2026-12-05");
    expect(r.json.movies.map((m: any) => m.id)).toEqual([3, 5, 1, 6, 7, 8]);
    r = await call("a@x.com", "GET", "/api/proposal-history?exclude=2026-11-21");
    expect(r.json.movies.map((m: any) => m.id)).toEqual([1, 3, 6, 7, 8]);
    r = await call("a@x.com", "GET", "/api/search?q=thing");
    expect(r.json.results.map((m: any) => m.watched)).toEqual([null, "2026-11-14"]);
    expect(r.json.results.map((m: any) => m.passedOver)).toEqual([1, 0]); // 1 passed over on Nov 14; 2 was picked
  });

  test("library lists movies no participant has seen; search marks library and seen-by", async () => {
    let askedFor: string[] = [];
    const lib = {
      async movies(names: string[]) {
        askedFor = names;
        return {
          matchedUsers: ["A", "B"],
          movies: [
            { tmdbId: 1, jellyfinId: "j1", title: "One", year: 2001, added: "2026-11-01", seenBy: [] },
            { tmdbId: 2, jellyfinId: "j2", title: "Two", year: 2002, added: "2026-10-01", seenBy: ["B"] },
            { tmdbId: 7, jellyfinId: "j7", title: "Seven", year: 2007, added: "2026-09-01", seenBy: [] },
          ],
        };
      },
      async poster() { return new Response("img"); },
    };
    const { call } = setup(lib);
    await call(null, "POST", "/api/setup", { email: "a@x.com", name: "A" });
    await call("a@x.com", "POST", "/api/participants", { email: "b@x.com", name: "B" });
    await call("a@x.com", "PUT", "/api/nights/2026-11-14/proposals", { tmdbIds: [7, 8, 9] });
    await call("a@x.com", "PUT", "/api/nights/2026-11-14/selection", { tmdbId: 7 }); // picked = watched
    let r = await call("a@x.com", "GET", "/api/library");
    expect(askedFor.sort()).toEqual(["A", "B"]);
    expect(r.json.movies.map((m: any) => m.id)).toEqual([1]);
    expect(r.json.movies[0]).toMatchObject({ inLibrary: true, jellyfinId: "j1" });
    r = await call("a@x.com", "GET", "/api/search?q=xy");
    expect(r.json.results.map((m: any) => [m.id, m.inLibrary, m.seenBy])).toEqual([[1, true, []], [2, true, ["B"]]]);
    expect((await call("a@x.com", "GET", "/api/library/poster/not-an-id")).status).toBe(404);
  });

  test("library endpoint is harmless when Jellyfin isn't configured", async () => {
    const { call } = setup();
    await call(null, "POST", "/api/setup", { email: "a@x.com", name: "A" });
    expect((await call("a@x.com", "GET", "/api/library")).json).toEqual({ enabled: false, movies: [], matchedUsers: [] });
  });

  test("non-admins can rename only themselves", async () => {
    const { call } = setup();
    await call(null, "POST", "/api/setup", { email: "a@x.com", name: "A" });
    await call("a@x.com", "POST", "/api/participants", { email: "b@x.com", name: "B" });
    expect((await call("b@x.com", "PATCH", "/api/participants/b%40x.com", { name: "Bobby" })).status).toBe(200);
    expect((await call("b@x.com", "PATCH", "/api/participants/a%40x.com", { name: "Nope" })).status).toBe(403);
    expect((await call("b@x.com", "PATCH", "/api/participants/b%40x.com", { isAdmin: true })).status).toBe(403);
  });
});
