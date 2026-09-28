import type { Database } from "bun:sqlite";
import { count } from "../db.ts";
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
  failed_attempts: number | null;
  retry_after: string | null;
}

const STALE_FROM_WHERE = `
  FROM threads t
  LEFT JOIN summaries su ON su.root_session_id = t.id
  LEFT JOIN digest_failures df ON df.root_session_id = t.id
  WHERE (su.root_session_id IS NULL
      OR su.source_last_ts IS NULL
      OR su.source_last_ts < t.last_ts
      OR su.prompt_version < $version)`;

// A thread active this recently is probably still being worked in: summarizing it
// now buys a summary that is stale again within minutes, so a drain waits.
export const DRAIN_SETTLE_MS = 30 * 60 * 1000;

const STALE_COLUMNS = `t.id, t.last_ts, t.first_ts, t.msgs, t.project_path, t.title,
       su.prompt_version AS summary_version, su.summarized_at AS summarized_at,
       df.attempts AS failed_attempts, df.retry_after AS retry_after`;

// With `drainAt`, only what a drain may take then: settled, and not backing off.
export const staleThreads = (db: Database, limit = 50, drainAt?: number): StaleThread[] =>
  db
    .query(
      `SELECT ${STALE_COLUMNS}
       ${STALE_FROM_WHERE}
         AND ($now IS NULL OR ((t.last_ts IS NULL OR t.last_ts < $settled)
                           AND (df.retry_after IS NULL OR df.retry_after <= $now)))
       ORDER BY t.last_ts DESC
       LIMIT $limit`,
    )
    .all({
      $version: DIGEST_PROMPT_VERSION,
      $limit: limit,
      $now: drainAt === undefined ? null : new Date(drainAt).toISOString(),
      $settled: drainAt === undefined ? null : new Date(drainAt - DRAIN_SETTLE_MS).toISOString(),
    }) as StaleThread[];

export const countStaleThreads = (db: Database): number =>
  count(db, `SELECT COUNT(*) AS c ${STALE_FROM_WHERE}`, { $version: DIGEST_PROMPT_VERSION });

export interface SummaryCoverage {
  threads: number;
  // Joined to threads: a relink can move a root, and a summary keyed on a stale
  // id is not coverage (`relevant` never reaches it through the view).
  summarized: number;
  stale: number;
  failing: number;
}

export const summaryCoverage = (db: Database): SummaryCoverage => ({
  threads: countThreads(db),
  summarized: count(
    db,
    "SELECT COUNT(*) AS c FROM summaries su JOIN threads t ON t.id = su.root_session_id",
  ),
  stale: countStaleThreads(db),
  failing: count(
    db,
    `SELECT COUNT(*) AS c ${STALE_FROM_WHERE} AND df.root_session_id IS NOT NULL`,
    {
      $version: DIGEST_PROMPT_VERSION,
    },
  ),
});
