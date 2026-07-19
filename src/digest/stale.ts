import type { Database } from "bun:sqlite";
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

// The staleness predicate, defined once (over the threads view aliased `t`
// left-joined to summaries aliased `su`) so the listing and the count can never
// drift on what "needs a (re)summary" means. A fixed literal the codebase owns;
// the prompt version stays a bound parameter.
const STALE_FROM_WHERE = `
  FROM threads t
  LEFT JOIN summaries su ON su.root_session_id = t.id
  WHERE t.msgs > 0
    AND (su.root_session_id IS NULL
      OR su.source_last_ts IS NULL
      OR su.source_last_ts < t.last_ts
      OR su.prompt_version < ?)`;

// Thread roots that need a (re)summary: never summarized, summarized before the
// thread's latest activity, or summarized by an older prompt version. Reads the
// shared `threads` rollup view (see db.ts), then left-joins summaries.
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

// The count form of the same predicate, for stats: no row materialization, no
// ORDER BY, just the number the `digest stale` listing would produce unbounded.
export const countStaleThreads = (db: Database): number =>
  (db.query(`SELECT COUNT(*) AS c ${STALE_FROM_WHERE}`).get(DIGEST_PROMPT_VERSION) as { c: number })
    .c;
