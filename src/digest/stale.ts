import type { Database } from "bun:sqlite";
import { count } from "../db.ts";
import { countThreads } from "../thread.ts";
import { DIGEST_PROMPT_VERSION } from "./prompt.ts";

// "no-coverage" is a summary reattachSummaries moved onto a new root: it never saw
// the session that took over, so it has no coverage point to compare.
export type StaleReason = "never" | "old-prompt" | "no-coverage" | "new-activity";

export type DrainHold = "backing-off" | "settling";

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
  reason: StaleReason;
  hold: DrainHold | null;
}

// NULL for a thread whose summary is current: the reason is the stale predicate.
const STALE_REASON = `CASE
         WHEN su.root_session_id IS NULL THEN 'never'
         WHEN su.prompt_version < $version THEN 'old-prompt'
         WHEN su.source_last_ts IS NULL THEN 'no-coverage'
         WHEN su.source_last_ts < t.last_ts THEN 'new-activity'
         END`;

const STALE_FROM_WHERE = `
  FROM threads t
  LEFT JOIN summaries su ON su.root_session_id = t.id
  LEFT JOIN digest_failures df ON df.root_session_id = t.id
  WHERE ${STALE_REASON} IS NOT NULL`;

// Backing off first: its wait is at least 6 hours, so it outlasts any settle.
const DRAIN_HOLD = `CASE
         WHEN df.retry_after > $now THEN 'backing-off'
         WHEN t.last_ts >= $settled THEN 'settling'
         END`;

// A thread active this recently is probably still being worked in: summarizing it
// now buys a summary that is stale again within minutes, so a drain waits.
export const DRAIN_SETTLE_MS = 30 * 60 * 1000;

const STALE_COLUMNS = `t.id, t.last_ts, t.first_ts, t.msgs, t.project_path, t.title,
       su.prompt_version AS summary_version, su.summarized_at AS summarized_at,
       df.attempts AS failed_attempts, df.retry_after AS retry_after,
       ${STALE_REASON} AS reason, ${DRAIN_HOLD} AS hold`;

export interface StaleQuery {
  limit?: number;
  now?: number;
  drain?: boolean;
}

export const staleThreads = (
  db: Database,
  { limit = 50, now = Date.now(), drain = false }: StaleQuery = {},
): StaleThread[] =>
  db
    .query(
      `SELECT * FROM (
         SELECT ${STALE_COLUMNS}
         ${STALE_FROM_WHERE}
       )
       WHERE NOT $drain OR hold IS NULL
       ORDER BY last_ts DESC
       LIMIT $limit`,
    )
    .all({
      $version: DIGEST_PROMPT_VERSION,
      $limit: limit,
      $drain: drain ? 1 : 0,
      $now: new Date(now).toISOString(),
      $settled: new Date(now - DRAIN_SETTLE_MS).toISOString(),
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
