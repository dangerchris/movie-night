import { serveStatic } from "hono/bun";
import { createApp } from "./app.ts";
import { parsePickerMode } from "./auth.ts";
import { openDb } from "./db.ts";
import { tmdbSource } from "./tmdb.ts";
import { jellyfinLibrary } from "./jellyfin.ts";
import { matrixNotifier } from "./matrix.ts";

const env = process.env;
const app = createApp({
  db: openDb(env.DB_PATH ?? "./data/movie-night.sqlite"),
  movies: tmdbSource(env.TMDB_TOKEN ?? ""),
  adminEmails: (env.ADMIN_EMAILS ?? "").split(","),
  library: jellyfinLibrary(env.JELLYFIN_URL ?? "", env.JELLYFIN_API_KEY ?? ""),
  notifier: matrixNotifier(env.MATRIX_HOMESERVER ?? "", env.MATRIX_ACCESS_TOKEN ?? "", env.MATRIX_ROOM ?? ""),
  auth: {
    accessTeamDomain: env.ACCESS_TEAM_DOMAIN ?? "",
    accessAud: env.ACCESS_AUD ?? "",
    picker: parsePickerMode(env.PICKER),
    publicUrl: env.PUBLIC_URL ?? "",
  },
});

// The page references app.js/style.css with a content hash so Cloudflare and browsers never serve
// stale code after a deploy; hashed assets can then be cached forever.
async function assetVersion(): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha1");
  for (const f of ["app.js", "style.css"]) hasher.update(await Bun.file(`./public/${f}`).arrayBuffer());
  return hasher.digest("hex").slice(0, 12);
}
app.get("/", async (c) => {
  const v = await assetVersion();
  const html = (await Bun.file("./public/index.html").text())
    .replace('href="/style.css"', `href="/style.css?v=${v}"`)
    .replace('src="/app.js"', `src="/app.js?v=${v}"`);
  return c.html(html, 200, { "Cache-Control": "no-cache" });
});
app.get("/index.html", (c) => c.redirect("/"));
app.use("/*", async (c, next) => {
  await next();
  if (c.res.ok) c.res.headers.set("Cache-Control", c.req.query("v") ? "public, max-age=31536000, immutable" : "no-cache");
});
app.use("/*", serveStatic({ root: "./public" }));

// Reminders: check every 5 minutes (each reminder is only ever sent once).
const remind = () => app.runReminders().catch((e) => console.error("reminders:", e));
setTimeout(remind, 15_000);
setInterval(remind, 5 * 60_000);

const port = Number(env.PORT ?? 8795);
console.log(`movie-night listening on http://0.0.0.0:${port}` + (env.TMDB_TOKEN ? "" : " (TMDB_TOKEN not set: search disabled)"));

export default { port, hostname: "0.0.0.0", fetch: app.fetch };
