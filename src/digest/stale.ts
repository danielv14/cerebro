import type { Database } from "bun:sqlite";
import { countThreads } from "../thread.ts";
import { DIGEST_PROMPT_VERSION } from "./prompt.ts";

export interface StaleThread {
  id: string;
  last_ts: string | null;
  first_ts: string | null;
  msgs: number;
  project_path: string | null;
  title: string | null;
  summary_version: number | null;
  summarized_at: string | null;
}

// The staleness predicate, defined once so the listing and the count cannot drift.
// t.msgs > 0 is redundant since the view took over excluding empty threads (#83);
// kept as a local statement of intent, harmless either way.
const STALE_FROM_WHERE = `
  FROM threads t
  LEFT JOIN summaries su ON su.root_session_id = t.id
  WHERE t.msgs > 0
    AND (su.root_session_id IS NULL
      OR su.source_last_ts IS NULL
      OR su.source_last_ts < t.last_ts
      OR su.prompt_version < ?)`;

// Never summarized, summarized before the thread's latest activity, or summarized
// by an older prompt version.
export const staleThreads = (db: Database, limit = 50): StaleThread[] =>
  db
    .query(
      `SELECT t.id, t.last_ts, t.first_ts, t.msgs, t.project_path, t.title,
              su.prompt_version AS summary_version, su.summarized_at AS summarized_at
       ${STALE_FROM_WHERE}
       ORDER BY t.last_ts DESC
       LIMIT ?`,
    )
    .all(DIGEST_PROMPT_VERSION, limit) as StaleThread[];

export const countStaleThreads = (db: Database): number =>
  (db.query(`SELECT COUNT(*) AS c ${STALE_FROM_WHERE}`).get(DIGEST_PROMPT_VERSION) as { c: number })
    .c;

export interface SummaryCoverage {
  threads: number;
  // Summaries that still key on a current thread root: a relink can move a root,
  // and a summary keyed on a stale id is not coverage (`relevant` never reaches it
  // through the threads view).
  summarized: number;
  stale: number;
}

// stats and doctor both call this instead of counting `summaries` themselves.
export const summaryCoverage = (db: Database): SummaryCoverage => ({
  threads: countThreads(db),
  summarized: (
    db
      .query(`SELECT COUNT(*) AS c FROM summaries su JOIN threads t ON t.id = su.root_session_id`)
      .get() as { c: number }
  ).c,
  stale: countStaleThreads(db),
});
