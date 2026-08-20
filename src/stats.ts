import type { Database } from "bun:sqlite";
import { countThreads } from "./thread.ts";

// The archive-stats reader: the small aggregate queries behind `cerebro stats`,
// plus the archive span that `skills` borrows for its coverage window.

export interface Stats {
  threads: number;
  sessions: number;
  messages: number;
  deletedSources: number;
  // Oldest and newest message timestamps: how far back the archive reaches.
  firstTs: string | null;
  lastTs: string | null;
  // Threads per project, largest first (top 5).
  topProjects: { project_path: string; threads: number }[];
}

// The archive's first and last timestamp. Read from the small sessions table, not a
// full scan of messages (ts is unindexed there): first_ts/last_ts are recomputed from
// messages on every session touch, so the aggregates are equivalent. Two readers want
// it (`stats` and `skills`, the latter to say which window its counts cover), so it
// lives here rather than as the same query written twice.
export const archiveSpan = (db: Database): { first: string | null; last: string | null } => {
  const span = db.query("SELECT MIN(first_ts) AS mn, MAX(last_ts) AS mx FROM sessions").get() as {
    mn: string | null;
    mx: string | null;
  };
  return { first: span.mn, last: span.mx };
};

export const stats = (db: Database): Stats => {
  const one = (sql: string): number => (db.query(sql).get() as { c: number }).c;
  const span = archiveSpan(db);
  return {
    threads: countThreads(db),
    sessions: one("SELECT COUNT(*) AS c FROM sessions"),
    messages: one("SELECT COUNT(*) AS c FROM messages"),
    // "Deleted" means the source was on disk and is now gone. A NULL source_file is
    // a subagent-only parent stub whose top-level transcript was never seen; it is
    // body-unavailable but nothing was deleted, so it must not inflate this count.
    deletedSources: one(
      "SELECT COUNT(*) AS c FROM sessions WHERE body_available = 0 AND source_file IS NOT NULL",
    ),
    firstTs: span.first,
    lastTs: span.last,
    topProjects: db
      .query(
        `SELECT project_path, COUNT(*) AS threads FROM threads
         WHERE project_path IS NOT NULL
         GROUP BY project_path ORDER BY threads DESC, project_path LIMIT 5`,
      )
      .all() as { project_path: string; threads: number }[],
  };
};
