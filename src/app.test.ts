import { describe, expect, test } from "bun:test";
import { createApp, tidyProviders } from "./app.ts";
import { openDb } from "./db.ts";
import { rotationRoles, upcomingNightDates } from "./schedule.ts";
import type { MovieSource } from "./tmdb.ts";

const fakeMovies: MovieSource = {
  async search(q) { return [{ id: 1, title: q, year: "2000", posterPath: null, overview: "", rating: 7 }]; },
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
function setup() {
  const app = createApp({
    db: openDb(":memory:"), movies: fakeMovies, adminEmails: [],
    auth: { accessTeamDomain: "", accessAud: "", picker: "localhost", publicUrl: "https://movies.example" },
    now: () => new Date("2026-11-10T17:00:00Z"),
  });
  const peer = (address: string) => ({ requestIP: () => ({ address }) });
  const call = async (as: string | null, method: string, path: string, body?: unknown, from = "127.0.0.1") => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (as) headers.cookie = `mn_user=${as}`;
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, peer(from));
    return { status: res.status, json: (await res.json()) as any };
  };
  return { app, call, peer };
}

describe("schedule", () => {
  test("upcoming dates land on the weekday", () => {
    expect(upcomingNightDates("2026-11-10", 6, 3)).toEqual(["2026-11-14", "2026-11-21", "2026-11-28"]);
    expect(upcomingNightDates("2026-11-14", 6, 1)).toEqual(["2026-11-14"]);
  });
  const weekOf = (k: number) => new Date(Date.parse("2026-11-14") + k * 7 * 86_400_000).toISOString().slice(0, 10);

  test("rotation for three people", () => {
    const order = ["a", "b", "c"];
    const pairs = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => { const r = rotationRoles(weekOf(from + i), "2026-11-14", order); return `${r.proposer}${r.chooser}`; });
    expect(pairs(0, 6)).toEqual(["ab", "bc", "ca", "ac", "cb", "ba"]);
    expect(pairs(6, 12)).toEqual(pairs(0, 6));
    expect(pairs(-6, 0)).toEqual(pairs(0, 6));
  });

  for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    test(`rotation invariants for ${n} people`, () => {
      const order = Array.from({ length: n }, (_, i) => `p${i}`);
      const len = n * (n - 1);
      const weeks = Array.from({ length: len * 2 }, (_, k) => rotationRoles(weekOf(k), "2026-11-14", order));
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

  test("weekday change keeps the rotation slot of the next night", async () => {
    const { call } = setup();
    await call(null, "POST", "/api/setup", { email: "a@x.com", name: "A" });
    await call("a@x.com", "POST", "/api/participants", { email: "b@x.com", name: "B" });
    await call("a@x.com", "POST", "/api/participants", { email: "c@x.com", name: "C" });
    await call("a@x.com", "GET", "/api/state"); // fixes anchor to 2026-11-14
    const r = await call("a@x.com", "PUT", "/api/settings", { nightWeekday: 5, nightTime: "20:00" });
    expect(r.json.upcoming[0].date).toBe("2026-11-13");
    expect(r.json.upcoming[0].proposer.name).toBe("A");
    expect(r.json.upcoming[0].time).toBe("20:00");
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

  test("non-admins can rename only themselves", async () => {
    const { call } = setup();
    await call(null, "POST", "/api/setup", { email: "a@x.com", name: "A" });
    await call("a@x.com", "POST", "/api/participants", { email: "b@x.com", name: "B" });
    expect((await call("b@x.com", "PATCH", "/api/participants/b%40x.com", { name: "Bobby" })).status).toBe(200);
    expect((await call("b@x.com", "PATCH", "/api/participants/a%40x.com", { name: "Nope" })).status).toBe(403);
    expect((await call("b@x.com", "PATCH", "/api/participants/b%40x.com", { isAdmin: true })).status).toBe(403);
  });
});
