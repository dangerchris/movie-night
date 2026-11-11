export interface LibraryMovie {
  tmdbId: number;
  jellyfinId: string;
  title: string;
  year: number | null;
  added: string | null;  // ISO timestamp the movie was added to the library
  seenBy: string[];      // participant names (matched to Jellyfin users by name) who have played it
}

export interface Library {
  /** Movies with TMDB ids; `names` are participant names to match against Jellyfin users. */
  movies(names: string[]): Promise<{ movies: LibraryMovie[]; matchedUsers: string[] }>;
  poster(jellyfinId: string): Promise<Response>;
}

const CACHE_MS = 10 * 60_000;

export function jellyfinLibrary(baseUrl: string, apiKey: string): Library | null {
  if (!baseUrl || !apiKey) return null;
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: `MediaBrowser Token="${apiKey}"`, Accept: "application/json" };
  const get = async (path: string): Promise<any> => {
    const res = await fetch(base + path, { headers });
    if (!res.ok) throw new Error(`Jellyfin ${path.split("?")[0]} failed (${res.status})`);
    return res.json();
  };
  let cache: { key: string; at: number; value: Promise<{ movies: LibraryMovie[]; matchedUsers: string[] }> } | null = null;

  async function load(names: string[]) {
    const wanted = new Set(names.map((n) => n.trim().toLowerCase()));
    const users = ((await get("/Users")) as any[]).filter((u) => wanted.has(String(u.Name).toLowerCase()));
    const fields = "Fields=ProviderIds,DateCreated&IncludeItemTypes=Movie&Recursive=true";
    const [all, ...played] = await Promise.all([
      get(`/Items?${fields}`),
      ...users.map((u) => get(`/Users/${u.Id}/Items?${fields}&IsPlayed=true`)),
    ]);
    const seen = new Map<string, string[]>();
    played.forEach((r: any, i: number) => {
      for (const item of r.Items ?? []) seen.set(item.Id, [...(seen.get(item.Id) ?? []), users[i].Name]);
    });
    const movies: LibraryMovie[] = [];
    for (const item of all.Items ?? []) {
      const tmdbId = Number(item.ProviderIds?.Tmdb);
      if (!Number.isInteger(tmdbId) || tmdbId <= 0) continue;
      movies.push({
        tmdbId, jellyfinId: item.Id, title: item.Name, year: item.ProductionYear ?? null,
        added: item.DateCreated ?? null, seenBy: seen.get(item.Id) ?? [],
      });
    }
    movies.sort((a, b) => (b.added ?? "").localeCompare(a.added ?? ""));
    return { movies, matchedUsers: users.map((u) => u.Name as string) };
  }

  return {
    movies(names) {
      const key = [...names].sort().join("|");
      if (!cache || cache.key !== key || Date.now() - cache.at > CACHE_MS) {
        const value = load(names);
        cache = { key, at: Date.now(), value };
        value.catch(() => { if (cache?.value === value) cache = null; });
      }
      return cache.value;
    },
    async poster(jellyfinId) {
      const res = await fetch(`${base}/Items/${jellyfinId}/Images/Primary?maxWidth=342&quality=85`, { headers });
      if (!res.ok) return new Response(null, { status: 404 });
      return new Response(res.body, {
        headers: { "content-type": res.headers.get("content-type") ?? "image/jpeg", "cache-control": "private, max-age=86400" },
      });
    },
  };
}
