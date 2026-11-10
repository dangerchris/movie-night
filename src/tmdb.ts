export interface SearchResult {
  id: number;
  title: string;
  year: string | null;
  posterPath: string | null;
  overview: string;
  rating: number | null;
}

export interface MovieDetails {
  id: number;
  title: string;
  originalTitle: string | null;
  year: string | null;
  releaseDate: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  tagline: string | null;
  overview: string;
  runtime: number | null;
  genres: string[];
  rating: number | null;
  voteCount: number;
  certifications: Record<string, string>; // ISO country -> e.g. "PG-13"
  directors: string[];
  cast: { name: string; character: string | null }[];
  imdbId: string | null;
  trailerKey: string | null;            // YouTube video key
  providers: Record<string, string[]>;  // ISO country -> streaming services (subscription/free)
}

export interface MovieSource {
  search(query: string): Promise<SearchResult[]>;
  details(id: number): Promise<MovieDetails>;
}

export class TmdbError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

const API = "https://api.themoviedb.org/3";

export function tmdbSource(token: string): MovieSource {
  // v4 read-access tokens are JWTs; v3 keys are 32 hex chars.
  const bearer = token.includes(".");
  async function get(path: string, params: Record<string, string> = {}): Promise<any> {
    if (!token) throw new TmdbError("TMDB_TOKEN is not set on the server", 503);
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (!bearer) url.searchParams.set("api_key", token);
    const res = await fetch(url, {
      headers: bearer ? { Authorization: `Bearer ${token}`, Accept: "application/json" } : { Accept: "application/json" },
    });
    if (res.status === 404) throw new TmdbError("Movie not found", 404);
    if (!res.ok) throw new TmdbError(`TMDB request failed (${res.status})`);
    return res.json();
  }

  return {
    async search(query) {
      const q = query.trim();
      const params: Record<string, string> = { include_adult: "false", language: "en-US", page: "1" };
      // "alien 1979" or "alien (1979)" narrows by release year.
      const m = q.match(/^(.+?)\s+\(?(\d{4})\)?$/);
      if (m && +m[2] >= 1880 && +m[2] <= 2100) { params.query = m[1]; params.primary_release_year = m[2]; }
      else params.query = q;
      const data = await get("/search/movie", params);
      return (data.results ?? []).slice(0, 18).map((r: any): SearchResult => ({
        id: r.id,
        title: r.title,
        year: r.release_date ? String(r.release_date).slice(0, 4) : null,
        posterPath: r.poster_path ?? null,
        overview: r.overview ?? "",
        rating: r.vote_count ? r.vote_average : null,
      }));
    },

    async details(id) {
      const d = await get(`/movie/${id}`, { append_to_response: "credits,release_dates,videos,watch/providers", language: "en-US" });
      const certifications: Record<string, string> = {};
      for (const c of d.release_dates?.results ?? []) {
        // Prefer theatrical (3) then any type with a certification.
        const dates = [...(c.release_dates ?? [])].sort((a: any, b: any) => (a.type === 3 ? -1 : 0) - (b.type === 3 ? -1 : 0));
        const cert = dates.find((r: any) => r.certification)?.certification;
        if (cert) certifications[c.iso_3166_1] = cert;
      }
      return {
        id: d.id,
        title: d.title,
        originalTitle: d.original_title && d.original_title !== d.title ? d.original_title : null,
        year: d.release_date ? String(d.release_date).slice(0, 4) : null,
        releaseDate: d.release_date || null,
        posterPath: d.poster_path ?? null,
        backdropPath: d.backdrop_path ?? null,
        tagline: d.tagline || null,
        overview: d.overview ?? "",
        runtime: d.runtime || null,
        genres: (d.genres ?? []).map((g: any) => g.name),
        rating: d.vote_count ? Math.round(d.vote_average * 10) / 10 : null,
        voteCount: d.vote_count ?? 0,
        certifications,
        directors: (d.credits?.crew ?? []).filter((c: any) => c.job === "Director").map((c: any) => c.name),
        cast: (d.credits?.cast ?? []).slice(0, 6).map((c: any) => ({ name: c.name, character: c.character || null })),
        imdbId: d.imdb_id ?? null,
        trailerKey: pickTrailer(d.videos?.results ?? []),
        providers: Object.fromEntries(
          Object.entries(d["watch/providers"]?.results ?? {}).map(([cc, r]: [string, any]) => [
            cc, [...new Set([...(r.flatrate ?? []), ...(r.free ?? []), ...(r.ads ?? [])].map((p: any) => p.provider_name as string))],
          ]).filter(([, names]) => (names as string[]).length > 0),
        ),
      };
    },
  };
}

function pickTrailer(videos: any[]): string | null {
  const yt = videos.filter((v) => v.site === "YouTube");
  const rank = (v: any) => (v.type === "Trailer" ? 0 : v.type === "Teaser" ? 2 : 4) + (v.official ? 0 : 1);
  const best = yt.filter((v) => v.type === "Trailer" || v.type === "Teaser").sort((a, b) => rank(a) - rank(b))[0];
  return best?.key ?? null;
}
