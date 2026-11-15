import type { Database } from "bun:sqlite";

/**
 * Letterboxd watchlists, read from the public watchlist pages (Letterboxd's API is invite-only).
 * Each film's TMDB id comes from its film page and is cached for good; watchlists are re-read
 * every few hours, serving the last copy meanwhile.
 */

export interface WatchlistFilm {
  slug: string;
  tmdbId: number;
  title: string;
  year: number | null;
}

export interface Watchlists {
  /** A user's watchlist (movies only), in Letterboxd's order (most recently added first). */
  watchlist(username: string): Promise<WatchlistFilm[]>;
}

const BASE = "https://letterboxd.com";
const REFRESH_MS = 6 * 3_600_000;
const MAX_PAGES = 20;
const CONCURRENCY = 3;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  Accept: "text/html",
};

/** "letterboxd.com/name/watchlist", "@name" or "name" -> "name"; null if it isn't a username. */
export function letterboxdUsername(input: string): string | null {
  const s = input.trim().replace(/^https?:\/\/(www\.)?letterboxd\.com\//i, "").replace(/^@/, "").split("/")[0];
  return /^[A-Za-z0-9_]{1,30}$/.test(s) ? s.toLowerCase() : null;
}

const decode = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Films on one watchlist page, and the number of pages. */
export function parseWatchlistPage(html: string): { films: { slug: string; title: string; year: number | null }[]; pages: number } {
  const films = [];
  for (const [tag] of html.matchAll(/<[^>]*\bdata-item-slug="[^"]*"[^>]*>/g)) {
    const attr = (name: string) => { const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? decode(m[1]) : null; };
    const slug = attr("data-item-slug")!;
    const full = attr("data-item-full-display-name") ?? attr("data-item-name") ?? slug;
    const m = full.match(/^(.*) \((\d{4})\)$/);
    films.push({ slug, title: m ? m[1] : full, year: m ? Number(m[2]) : null });
  }
  const pages = Math.max(1, ...[...html.matchAll(/\/watchlist\/page\/(\d+)\//g)].map((m) => Number(m[1])));
  return { films, pages };
}

/** The TMDB movie id on a film page; null for TV and anything without one. */
export function parseFilmPage(html: string): number | null {
  const id = html.match(/\bdata-tmdb-id="(\d+)"/)?.[1];
  const type = html.match(/\bdata-tmdb-type="([a-z]+)"/)?.[1] ?? "movie";
  return id && type === "movie" ? Number(id) : null;
}

export function letterboxdWatchlists(db: Database, fetcher: typeof fetch = fetch): Watchlists {
  const getId = db.query<{ tmdb_id: number | null }, [string]>("SELECT tmdb_id FROM letterboxd_films WHERE slug = ?");
  const putId = db.query("INSERT OR REPLACE INTO letterboxd_films (slug, tmdb_id) VALUES (?, ?)");
  const cache = new Map<string, { at: number; films: Promise<WatchlistFilm[]> }>();

  const page = async (path: string) => {
    const res = await fetcher(BASE + path, { headers: HEADERS });
    if (!res.ok) throw new Error(`Letterboxd ${path} failed (${res.status})`);
    return res.text();
  };

  async function tmdbId(slug: string): Promise<number | null> {
    const row = getId.get(slug);
    if (row) return row.tmdb_id;
    const id = parseFilmPage(await page(`/film/${slug}/`));
    putId.run(slug, id);
    return id;
  }

  async function load(user: string): Promise<WatchlistFilm[]> {
    const first = parseWatchlistPage(await page(`/${user}/watchlist/`));
    const rest = await Promise.all(Array.from({ length: Math.min(first.pages, MAX_PAGES) - 1 },
      (_, i) => page(`/${user}/watchlist/page/${i + 2}/`).then(parseWatchlistPage)));
    const listed = [first, ...rest].flatMap((p) => p.films);
    const ids = new Map<string, number | null>();
    for (let i = 0; i < listed.length; i += CONCURRENCY)
      await Promise.all(listed.slice(i, i + CONCURRENCY).map(async (f) => {
        try { ids.set(f.slug, await tmdbId(f.slug)); } catch (e) { console.error(e); }
      }));
    return listed.flatMap((f) => { const id = ids.get(f.slug); return id ? [{ ...f, tmdbId: id }] : []; });
  }

  return {
    watchlist(username) {
      const user = username.toLowerCase();
      const hit = cache.get(user);
      if (hit && Date.now() - hit.at < REFRESH_MS) return hit.films;
      const films = load(user);
      films.then(
        () => cache.set(user, { at: Date.now(), films }),
        (e) => console.error("letterboxd:", e));
      // Serve the last good copy while a refresh runs; the first load waits.
      if (hit) { hit.at = Date.now(); return hit.films; }
      cache.set(user, { at: Date.now(), films });
      films.catch(() => { if (cache.get(user)?.films === films) cache.delete(user); });
      return films;
    },
  };
}
