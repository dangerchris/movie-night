import { serveStatic } from "hono/bun";
import { createApp } from "./app.ts";
import { parsePickerMode } from "./auth.ts";
import { openDb } from "./db.ts";
import { tmdbSource } from "./tmdb.ts";

const env = process.env;
const app = createApp({
  db: openDb(env.DB_PATH ?? "./data/movie-night.sqlite"),
  movies: tmdbSource(env.TMDB_TOKEN ?? ""),
  adminEmails: (env.ADMIN_EMAILS ?? "").split(","),
  auth: {
    accessTeamDomain: env.ACCESS_TEAM_DOMAIN ?? "",
    accessAud: env.ACCESS_AUD ?? "",
    picker: parsePickerMode(env.PICKER),
    publicUrl: env.PUBLIC_URL ?? "",
  },
});

app.use("/*", serveStatic({ root: "./public" }));

const port = Number(env.PORT ?? 8795);
console.log(`movie-night listening on http://0.0.0.0:${port}` + (env.TMDB_TOKEN ? "" : " (TMDB_TOKEN not set: search disabled)"));

export default { port, hostname: "0.0.0.0", fetch: app.fetch };
