import { Database } from "bun:sqlite";
import fs from "node:fs";
import { dirname } from "node:path";
import { THREADS_VIEW_DDL, threadsViewIsCurrent } from "./thread.ts";

// Schema, migrations and openDb. Design notes: docs/architecture.md ("Database").

// Bump whenever SCHEMA or migrate() changes, the threads view DDL included. openDb
// skips the whole DDL block when the stored version matches (and the threads view
// has the expected shape), so the hook hot path opens without schema work.
export const SCHEMA_VERSION = 6;

// Run on every open, outside the version-gated DDL: busy_timeout / foreign_keys do
// not persist in the file; journal_mode does, but cannot be changed inside a
// transaction, so it lives here as a no-op re-apply.
const CONNECTION_PRAGMAS = `
-- cerebro is opened concurrently by short-lived processes against one WAL file;
-- with the default timeout of 0 a writer that meets a checkpoint or WAL-recovery
-- window fails immediately with SQLITE_BUSY.
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
  -- 1 = cerebro's own digest summarization transcript: permanently excluded from
  -- indexing, even if it grows after detection.
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
  -- Both nullable: rows written by a pre-adapter binary carry NULL until
  -- migrate() backfills provider.
  provider          TEXT,
  model             TEXT,
  title             TEXT,
  -- Persisted so an incremental run that only sees a lower-priority title event
  -- can never clobber a higher-priority title indexed earlier.
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
  -- Legacy, always NULL. Kept on purpose: the deployed hook binary is a frozen
  -- snapshot whose INSERT names this column; dropping it would make every
  -- automated index run fail silently until the next 'bun run deploy'.
  line_no      INTEGER,
  ts           TEXT,
  role         TEXT,
  text         TEXT,
  is_sidechain INTEGER NOT NULL DEFAULT 0  -- 1 = subagent / sidechain turn
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
-- Messages are normally insert-only, but 'index --rebuild' re-flattens stored text
-- in place via an upsert; this keeps the FTS index in sync with those updates.
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text)
    VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;

-- One LLM-written summary per logical thread. Derived and regenerable: safe to
-- drop and rebuild. source_last_ts is the thread's last_ts at summarization time,
-- so later activity (or an older prompt_version) marks it stale.
CREATE TABLE IF NOT EXISTS summaries (
  root_session_id TEXT PRIMARY KEY,
  summary         TEXT NOT NULL,
  prompt_version  INTEGER NOT NULL,
  model           TEXT,
  summarized_at   TEXT NOT NULL,
  source_last_ts  TEXT
);

-- Re-summarizing upserts (ON CONFLICT DO UPDATE keeps the rowid stable), so an
-- UPDATE trigger alongside insert/delete keeps the index in sync.
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

-- Owned by thread.ts and consumed here as an opaque DDL fragment.
${THREADS_VIEW_DDL}`;

// Table and column names are fixed literals the codebase owns, so the
// interpolation is safe.
const addColumnIfMissing = (db: Database, table: string, column: string, ddl: string): void => {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
};

// Idempotent migrations for databases created by an earlier schema version.
const migrate = (db: Database): void => {
  addColumnIfMissing(db, "messages", "is_sidechain", "is_sidechain INTEGER NOT NULL DEFAULT 0");
  // Pre-migration titles get priority 0: the next title event of any priority may
  // replace them once, after which the real priority is tracked.
  addColumnIfMissing(db, "sessions", "title_priority", "title_priority INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "index_state", "is_digest", "is_digest INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "sessions", "provider", "provider TEXT");
  addColumnIfMissing(db, "sessions", "model", "model TEXT");
  // Everything indexed before the source-adapter seam existed came from Claude
  // Code, so a NULL provider is safe to backfill. Re-run on every version bump:
  // rows a frozen pre-adapter hook binary writes later also heal here.
  db.run(`UPDATE sessions SET provider = 'claude-code' WHERE provider IS NULL`);
};

// null when there is nothing to measure (an in-memory database, or a path that
// does not exist yet).
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
    // DDL, migrations, and the version stamp commit as ONE transaction: two
    // binaries built for different SCHEMA_VERSIONs racing the first open after an
    // upgrade could otherwise interleave a current-looking stamp over the other
    // build's view (the view-shape re-check in upToDate heals databases an old
    // unwrapped binary already wedged). The migrations are check-then-ALTER and
    // need the same lock; BEGIN IMMEDIATE takes it up front and the state is
    // re-checked under it, so the loser sees the winner's work and skips.
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
