import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { addDays, todayInTz } from "./schedule.ts";

const MIGRATIONS: (string | ((db: Database) => void))[] = [
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
  // Off-cycle nights: a night keeps its rotation slot (nights.date) but can happen on another date/time.
  `
  ALTER TABLE nights ADD COLUMN actual_date TEXT;
  ALTER TABLE nights ADD COLUMN time TEXT;
  `,
  // Nights become a queue (the lineup) that fills the calendar's dates in order, with no gaps.
  (db) => {
    db.exec(`
      CREATE TABLE lineup (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        seq              REAL NOT NULL,      -- order among nights still to come
        held_on          TEXT,               -- the date it happened, once past
        proposer_email   TEXT,
        chooser_email    TEXT,
        selected_tmdb_id INTEGER,
        selected_by      TEXT,
        selected_at      TEXT,
        updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE lineup_proposals (
        night_id    INTEGER NOT NULL,
        slot        INTEGER NOT NULL,
        tmdb_id     INTEGER NOT NULL,
        proposed_by TEXT,
        PRIMARY KEY (night_id, slot)
      );
      -- One-off changes to the weekly schedule: skip a regular date, add an extra one (optionally
      -- recording which date it replaced), or give a date its own start time.
      CREATE TABLE calendar (
        date       TEXT PRIMARY KEY,
        kind       TEXT NOT NULL CHECK (kind IN ('skip', 'extra', 'time')),
        time       TEXT,
        moved_from TEXT
      );
    `);
    const setting = (k: string) => (db.query("SELECT value FROM settings WHERE key = ?").get(k) as { value: string } | null)?.value;
    const today = todayInTz(setting("timezone") ?? "America/Toronto");
    type Row = { date: string; proposer_email: string | null; chooser_email: string | null; selected_tmdb_id: number | null;
      selected_by: string | null; selected_at: string | null; actual_date: string | null; time: string | null };
    const rows = db.query(
      `SELECT * FROM nights n WHERE proposer_email IS NOT NULL OR chooser_email IS NOT NULL OR selected_tmdb_id IS NOT NULL
         OR EXISTS (SELECT 1 FROM proposals p WHERE p.night_date = n.date)
       ORDER BY COALESCE(actual_date, date), date`).all() as Row[];
    const insNight = db.query(
      `INSERT INTO lineup (seq, held_on, proposer_email, chooser_email, selected_tmdb_id, selected_by, selected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`);
    rows.forEach((r, i) => {
      const on = r.actual_date ?? r.date;
      const { id } = insNight.get(i, on < today ? on : null, r.proposer_email, r.chooser_email,
        r.selected_tmdb_id, r.selected_by, r.selected_at) as { id: number };
      db.query(`INSERT INTO lineup_proposals (night_id, slot, tmdb_id, proposed_by)
                SELECT ?, slot, tmdb_id, proposed_by FROM proposals WHERE night_date = ?`).run(id, r.date);
    });
    // Moved nights and custom times become calendar changes.
    const all = db.query("SELECT * FROM nights WHERE actual_date IS NOT NULL OR time IS NOT NULL").all() as Row[];
    for (const r of all) {
      if (r.actual_date) {
        db.query("INSERT OR REPLACE INTO calendar (date, kind) VALUES (?, 'skip')").run(r.date);
        db.query("INSERT OR REPLACE INTO calendar (date, kind, time, moved_from) VALUES (?, 'extra', ?, ?)").run(r.actual_date, r.time, r.date);
      } else {
        db.query("INSERT OR REPLACE INTO calendar (date, kind, time) VALUES (?, 'time', ?)").run(r.date, r.time);
      }
    }
    // Dates before today are settled; the lineup starts filling from today.
    db.query("INSERT OR REPLACE INTO settings (key, value) VALUES ('lineup_through', ?)").run(addDays(today, -1));
  },
];

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      const m = MIGRATIONS[v];
      if (typeof m === "string") db.exec(m); else m(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
  return db;
}
