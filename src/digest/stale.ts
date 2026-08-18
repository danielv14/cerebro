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

// The staleness predicate, defined once (over the threads view aliased `t`
// left-joined to summaries aliased `su`) so the listing and the count can never
// drift on what "needs a (re)summary" means. A fixed literal the codebase owns;
// the prompt version stays a bound parameter.
//
// t.msgs > 0 is redundant since the view took over excluding empty threads (#83);
// kept as a local statement of intent ("nothing to summarize"), harmless either way.
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

export interface SummaryCoverage {
  threads: number;
  // Summaries that still key on a current thread root. A relink (relinkThreads can
  // move a root) leaves a summary keyed on an id that is no longer one, and such a
  // row is not coverage: `relevant` will never reach it through the threads view.
  summarized: number;
  stale: number;
}

// The one summary-coverage reading, owned here next to the staleness predicate it
// includes. stats and doctor both call this instead of counting `summaries`
// themselves, so the number they print cannot drift apart.
export const summaryCoverage = (db: Database): SummaryCoverage => ({
  threads: countThreads(db),
  summarized: (
    db
      .query(`SELECT COUNT(*) AS c FROM summaries su JOIN threads t ON t.id = su.root_session_id`)
      .get() as { c: number }
  ).c,
  stale: countStaleThreads(db),
});
