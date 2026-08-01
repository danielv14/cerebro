import { Database } from "bun:sqlite";
import fs from "node:fs";
import { dirname } from "node:path";

// Bump whenever SCHEMA or migrate() changes. openDb stamps it into PRAGMA
// user_version and skips the whole DDL block when the stored version matches (and
// the threads view has the expected shape, see THREADS_VIEW_COLUMNS), so the
// per-prompt hook hot path (UserPromptSubmit -> relevant) opens without any schema
// work. An old database (or a fresh one, user_version 0) runs the DDL + migrations
// once and is stamped.
export const SCHEMA_VERSION = 5;

// Per-connection pragmas: these run on every open, outside the version-gated DDL.
// busy_timeout / foreign_keys do not persist in the file; journal_mode does, but it
// cannot be changed inside a transaction, so it lives here (a no-op re-apply on an
// already-WAL database) rather than in the transactional migration block below.
const CONNECTION_PRAGMAS = `
-- Wait up to 5s for a lock instead of failing instantly. cerebro is opened
-- concurrently by short-lived processes (the index/digest hooks, manual reads,
-- and a draining batch) against one WAL file; with the default timeout of 0 a
-- writer that meets a checkpoint or WAL-recovery window fails immediately with
-- SQLITE_BUSY. A timeout rides out those sub-second windows.
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
  -- 1 = detected as cerebro's own digest summarization transcript. The file is
  -- permanently excluded from indexing, even if it grows after detection (the
  -- detection itself only inspects a read that starts at byte 0).
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
  title             TEXT,
  -- Priority of the stored title (custom-title 3 > ai-title 2 > summary 1, 0 = none).
  -- Persisted so an incremental run that only sees a lower-priority title event can
  -- never clobber a higher-priority title indexed earlier.
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
  -- Legacy, always NULL and no longer written. Kept (never dropped) on purpose:
  -- the deployed hook binary is a frozen snapshot whose INSERT names this column;
  -- dropping it would make every automated index run fail silently until the next
  -- 'bun run deploy'. Harmless to carry.
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

-- One LLM-written summary per logical thread (keyed by root_session_id), the
-- curated layer on top of the verbatim archive. Derived and regenerable: safe to
-- drop and rebuild. source_last_ts is the thread's last_ts at summarization time,
-- so a thread that gained messages since (or was summarized by an older
-- prompt_version) can be detected as stale and re-summarized.
CREATE TABLE IF NOT EXISTS summaries (
  root_session_id TEXT PRIMARY KEY,
  summary         TEXT NOT NULL,
  prompt_version  INTEGER NOT NULL,
  model           TEXT,
  summarized_at   TEXT NOT NULL,
  source_last_ts  TEXT
);

-- External-content FTS over the summary text. summaries is upserted (re-summarize
-- replaces via ON CONFLICT DO UPDATE, which keeps the rowid stable), so an UPDATE
-- trigger alongside insert/delete keeps the index in sync without rowid churn.
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

-- The single sessions -> threads rollup. A logical thread is a root session plus
-- its resumes and folded subagents, all sharing one root_session_id. Every caller
-- that lists or scopes threads (listThreads, recentThreads, staleThreads) selects
-- from this view rather than re-deriving the GROUP BY, so the rollup shape is
-- defined exactly once.
--
-- project_path, git_root, git_branch, and title use a root-preferring COALESCE: take the
-- root session's value, and only fall back to MAX over the resumes when the root's
-- is NULL. The aggregate must run over the unfiltered rows, so callers that scope by
-- project filter the view's output AFTER the rollup. Filtering raw sessions before
-- the GROUP BY would drop resume/subagent rows whose project_path is NULL or differs,
-- undercounting msgs and sessions_in_thread. body_available is MIN so a thread is
-- only body-available if every folded session still has its source on disk.
--
-- HAVING SUM(msg_count) > 0 is what makes "a thread" mean the same thing to every
-- reader (#83). A session opened and closed right away still gets a sessions row
-- (the sidecar metadata that outlives Claude Code's own cleanup) with msg_count 0;
-- rolled up it was an empty thread showing as '0 msgs' / '(untitled)' in sessions,
-- recent, and the stats thread count, while 'digest stale' already excluded it.
-- Excluding it here rather than per listing keeps countThreads and topProjects from
-- disagreeing with the listings. Nothing is deleted: the sessions rows stay, so
-- 'show' on such a session still resolves and the deleted-source stats (which
-- read sessions) are unaffected.
--
-- Replacing this definition needs a SCHEMA_VERSION bump AND the DROP below (on an
-- existing database CREATE VIEW IF NOT EXISTS silently keeps the old view), AND an
-- update to THREADS_VIEW_COLUMNS if the column list changed.
DROP VIEW IF EXISTS threads;
CREATE VIEW IF NOT EXISTS threads AS
  SELECT
    r.root_session_id AS id,
    MAX(r.last_ts)    AS last_ts,
    MIN(r.first_ts)   AS first_ts,
    SUM(r.msg_count)  AS msgs,
    COUNT(*)          AS sessions_in_thread,
    COALESCE(
      MAX(CASE WHEN r.session_id = r.root_session_id THEN r.project_path END),
      MAX(r.project_path)
    ) AS project_path,
    COALESCE(
      MAX(CASE WHEN r.session_id = r.root_session_id THEN r.git_root END),
      MAX(r.git_root)
    ) AS git_root,
    COALESCE(
      MAX(CASE WHEN r.session_id = r.root_session_id THEN r.git_branch END),
      MAX(r.git_branch)
    ) AS git_branch,
    COALESCE(
      MAX(CASE WHEN r.session_id = r.root_session_id THEN r.title END),
      MAX(r.title)
    ) AS title,
    MIN(r.body_available) AS body_available
  FROM sessions r
  GROUP BY r.root_session_id
  HAVING SUM(r.msg_count) > 0;
`;

// Add a column iff it does not exist. Idempotent by construction; each migration
// below is one call instead of a repeated table_info/check/ALTER block. Table and
// column names are fixed literals the codebase owns (never user input), so the
// interpolation is safe.
const addColumnIfMissing = (db: Database, table: string, column: string, ddl: string): void => {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
};

// The threads view's column list, in view order. Keep in lockstep with the CREATE
// VIEW in SCHEMA. openDb compares this against the live view on every open (one
// PRAGMA, and only when the version stamp already matches): a binary built for a
// different SCHEMA_VERSION racing this one through the first open after an upgrade
// can leave a current-looking stamp over the other build's view, and version-gating
// alone would then trust that forever while every reader of a missing column fails.
const THREADS_VIEW_COLUMNS = [
  "id",
  "last_ts",
  "first_ts",
  "msgs",
  "sessions_in_thread",
  "project_path",
  "git_root",
  "git_branch",
  "title",
  "body_available",
].join(",");

const threadsViewIsCurrent = (db: Database): boolean => {
  const columns = db.query("PRAGMA table_info(threads)").all() as { name: string }[];
  return columns.map((column) => column.name).join(",") === THREADS_VIEW_COLUMNS;
};

// Idempotent migrations for databases created by an earlier schema version.
const migrate = (db: Database): void => {
  addColumnIfMissing(db, "messages", "is_sidechain", "is_sidechain INTEGER NOT NULL DEFAULT 0");
  // Pre-migration titles get priority 0: the next title event of any priority may
  // replace them once, after which the real priority is tracked.
  addColumnIfMissing(db, "sessions", "title_priority", "title_priority INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "index_state", "is_digest", "is_digest INTEGER NOT NULL DEFAULT 0");
};

// Size of the database file, or null when there is nothing to measure (an
// in-memory database, or a path that does not exist yet). Both `stats` and
// `doctor` report it, from here rather than each guarding its own statSync.
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
  const version = (): number =>
    (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;

  const upToDate = (): boolean => version() === SCHEMA_VERSION && threadsViewIsCurrent(db);

  if (!upToDate()) {
    // DDL, migrations, and the version stamp commit as ONE transaction. Run
    // unwrapped (as the DDL used to be), there is a window where the view and the
    // stamp disagree: two binaries built for different SCHEMA_VERSIONs racing the
    // first open after an upgrade could interleave to the current stamp over the
    // other build's view, which the version gate would then trust forever (the
    // view-shape re-check in upToDate is the second half of that defense, healing
    // a database an old unwrapped binary has already wedged). The migrations need
    // the lock for their own reason: they are check-then-ALTER, and two racing
    // processes could both pass the column-existence check and the loser's ALTER
    // would throw. BEGIN IMMEDIATE takes the write lock up front and the state is
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
