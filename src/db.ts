import { Database } from "bun:sqlite";
import fs from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS index_state (
  source_file   TEXT PRIMARY KEY,
  bytes_indexed INTEGER NOT NULL DEFAULT 0,
  mtime_ms      REAL    NOT NULL DEFAULT 0,
  indexed_at    TEXT
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
};

export const openDb = (path: string): Database => {
  fs.mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  migrate(db);
  return db;
};
