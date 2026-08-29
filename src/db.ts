import { Database } from "bun:sqlite";
import fs from "node:fs";
import { dirname } from "node:path";
import { THREADS_VIEW_DDL, threadsViewIsCurrent } from "./thread.ts";

// Design notes: docs/architecture.md ("Database").

// Bump whenever SCHEMA or migrate() changes, the threads view DDL included.
export const SCHEMA_VERSION = 6;

// Per-connection, outside the version gate: busy_timeout/foreign_keys do not
// persist, and journal_mode cannot be changed inside a transaction.
const CONNECTION_PRAGMAS = `
-- Short-lived processes share one WAL file; timeout 0 would fail with
-- SQLITE_BUSY on every checkpoint window.
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS index_state (
  source_file   TEXT PRIMARY KEY,
  bytes_indexed INTEGER NOT NULL DEFAULT 0,
  mtime_ms      REAL    NOT NULL DEFAULT 0,
  indexed_at    TEXT,
  -- 1 = cerebro's own digest transcript: permanently excluded from indexing.
  is_digest     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id        TEXT PRIMARY KEY,
  project_dir       TEXT,
  project_path      TEXT,
  cwd               TEXT,
  git_root          TEXT,
  git_remote        TEXT,
  git_branch        TEXT,
  source_file       TEXT,
  provider          TEXT,
  model             TEXT,
  title             TEXT,
  -- Persisted so a later lower-priority title event can never clobber a
  -- higher-priority title indexed earlier.
  title_priority    INTEGER NOT NULL DEFAULT 0,
  first_ts          TEXT,
  last_ts           TEXT,
  msg_count         INTEGER NOT NULL DEFAULT 0,
  parent_session_id TEXT,
  root_session_id   TEXT,
  body_available    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY,
  uuid         TEXT UNIQUE NOT NULL,
  session_id   TEXT NOT NULL,
  parent_uuid  TEXT,
  -- Legacy, always NULL. Kept: the deployed hook binary is a frozen snapshot
  -- whose INSERT names this column; dropping it breaks automated indexing until
  -- the next 'bun run deploy'.
  line_no      INTEGER,
  ts           TEXT,
  role         TEXT,
  text         TEXT,
  is_sidechain INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_parent  ON messages(parent_uuid);
CREATE INDEX IF NOT EXISTS idx_sessions_root    ON sessions(root_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_lastts  ON sessions(last_ts);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(text, content='messages', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text)
    VALUES ('delete', old.id, old.text);
END;
-- 'index --rebuild' re-flattens stored text in place via an upsert.
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text)
    VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS summaries (
  root_session_id TEXT PRIMARY KEY,
  summary         TEXT NOT NULL,
  prompt_version  INTEGER NOT NULL,
  model           TEXT,
  summarized_at   TEXT NOT NULL,
  -- The thread's last_ts at summarization time; later activity marks it stale.
  source_last_ts  TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts
  USING fts5(summary, content='summaries', content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON summaries BEGIN
  INSERT INTO summaries_fts(rowid, summary) VALUES (new.rowid, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS summaries_ad AFTER DELETE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, summary)
    VALUES ('delete', old.rowid, old.summary);
END;
CREATE TRIGGER IF NOT EXISTS summaries_au AFTER UPDATE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, summary)
    VALUES ('delete', old.rowid, old.summary);
  INSERT INTO summaries_fts(rowid, summary) VALUES (new.rowid, new.summary);
END;

${THREADS_VIEW_DDL}`;

// Table and column names are codebase literals, so the interpolation is safe.
const addColumnIfMissing = (db: Database, table: string, column: string, ddl: string): void => {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
};

const migrate = (db: Database): void => {
  addColumnIfMissing(db, "messages", "is_sidechain", "is_sidechain INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "sessions", "title_priority", "title_priority INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "index_state", "is_digest", "is_digest INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "sessions", "provider", "provider TEXT");
  addColumnIfMissing(db, "sessions", "model", "model TEXT");
  // Safe: everything indexed before the adapter seam came from Claude Code, and
  // new-code rows always carry their adapter's id.
  db.run(`UPDATE sessions SET provider = 'claude-code' WHERE provider IS NULL`);
};

export const dbFileSize = (path: string): number | null => {
  try {
    return fs.statSync(path).size;
  } catch {
    return null;
  }
};

export const openDb = (path: string): Database => {
  fs.mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(CONNECTION_PRAGMAS);
  const upToDate = (): boolean =>
    (db.query("PRAGMA user_version").get() as { user_version: number }).user_version ===
      SCHEMA_VERSION && threadsViewIsCurrent(db);

  if (!upToDate()) {
    // DDL, migrations and the stamp commit as ONE transaction, and the state is
    // re-checked under the write lock: two binaries built for different
    // SCHEMA_VERSIONs racing the first open could otherwise leave a current
    // stamp over the other build's view, and the migrations are check-then-ALTER.
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!upToDate()) {
        db.exec(SCHEMA);
        migrate(db);
        db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return db;
};
