import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE participants (
    email      TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL,
    active     INTEGER NOT NULL DEFAULT 1,
    is_admin   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  -- A row exists once something is stored for a night (proposals, a pick or a role override).
  CREATE TABLE nights (
    date             TEXT PRIMARY KEY,   -- YYYY-MM-DD in the configured timezone
    proposer_email   TEXT,               -- NULL = follow the rotation
    chooser_email    TEXT,
    selected_tmdb_id INTEGER,
    selected_by      TEXT,
    selected_at      TEXT,
    updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE proposals (
    night_date  TEXT NOT NULL,
    slot        INTEGER NOT NULL,
    tmdb_id     INTEGER NOT NULL,
    proposed_by TEXT,
    PRIMARY KEY (night_date, slot)
  );
  -- Normalised TMDB details, cached.
  CREATE TABLE movies (
    tmdb_id    INTEGER PRIMARY KEY,
    data       TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  `,
];

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
  return db;
}
