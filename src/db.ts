import { Database } from "bun:sqlite";
import fs from "node:fs";
import { dirname } from "node:path";

// Bump whenever SCHEMA or migrate() changes. openDb stamps it into PRAGMA
// user_version and skips the whole DDL block when the stored version matches, so
// the per-prompt hook hot path (UserPromptSubmit -> relevant) opens without any
// schema work. An old database (or a fresh one, user_version 0) runs the DDL +
// migrations once and is stamped.
export const SCHEMA_VERSION = 3;

// Per-connection pragmas: these do not persist in the database file, so they run
// on every open, outside the version-gated DDL.
const CONNECTION_PRAGMAS = `
-- Wait up to 5s for a lock instead of failing instantly. cerebro is opened
-- concurrently by short-lived processes (the index/digest hooks, manual reads,
-- and a draining batch) against one WAL file; with the default timeout of 0 a
-- writer that meets a checkpoint or WAL-recovery window fails immediately with
-- SQLITE_BUSY. A timeout rides out those sub-second windows.
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
`;

const SCHEMA = `
PRAGMA journal_mode = WAL;

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
-- project_path, git_root, and title use a root-preferring COALESCE: take the
-- root session's value, and only fall back to MAX over the resumes when the root's
-- is NULL. The aggregate must run over the unfiltered rows, so callers that scope by
-- project filter the view's output AFTER the rollup. Filtering raw sessions before
-- the GROUP BY would drop resume/subagent rows whose project_path is NULL or differs,
-- undercounting msgs and sessions_in_thread. body_available is MIN so a thread is
-- only body-available if every folded session still has its source on disk.
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
      MAX(CASE WHEN r.session_id = r.root_session_id THEN r.title END),
      MAX(r.title)
    ) AS title,
    MIN(r.body_available) AS body_available
  FROM sessions r
  GROUP BY r.root_session_id;
`;

// Idempotent migrations for databases created by an earlier schema version.
const migrate = (db: Database): void => {
  const columns = db.query("PRAGMA table_info(messages)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "is_sidechain")) {
    db.run("ALTER TABLE messages ADD COLUMN is_sidechain INTEGER NOT NULL DEFAULT 0");
  }
  const sessionColumns = db.query("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!sessionColumns.some((c) => c.name === "title_priority")) {
    // Pre-migration titles get priority 0: the next title event of any priority may
    // replace them once, after which the real priority is tracked.
    db.run("ALTER TABLE sessions ADD COLUMN title_priority INTEGER NOT NULL DEFAULT 0");
  }
  const stateColumns = db.query("PRAGMA table_info(index_state)").all() as { name: string }[];
  if (!stateColumns.some((c) => c.name === "is_digest")) {
    db.run("ALTER TABLE index_state ADD COLUMN is_digest INTEGER NOT NULL DEFAULT 0");
  }
  if (columns.some((c) => c.name === "line_no")) {
    // Dead column: it was never populated (always NULL). Nothing references it.
    db.run("ALTER TABLE messages DROP COLUMN line_no");
  }
};

export const openDb = (path: string): Database => {
  fs.mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(CONNECTION_PRAGMAS);
  const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
  if (user_version !== SCHEMA_VERSION) {
    // The DDL is idempotent (IF NOT EXISTS everywhere), so two processes racing
    // through a first open are safe; busy_timeout above rides out lock windows.
    db.exec(SCHEMA);
    migrate(db);
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  return db;
};
