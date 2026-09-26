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
  // Both null when the thread has no failed attempt on record.
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

// Bound by `$settled` and `$now`, both ISO instants.
const DRAINABLE = `(t.last_ts IS NULL OR t.last_ts < $settled)
      AND (df.retry_after IS NULL OR df.retry_after <= $now)`;

const drainWindow = (now: number) => ({
  $settled: new Date(now - DRAIN_SETTLE_MS).toISOString(),
  $now: new Date(now).toISOString(),
});

const STALE_COLUMNS = `t.id, t.last_ts, t.first_ts, t.msgs, t.project_path, t.title,
       su.prompt_version AS summary_version, su.summarized_at AS summarized_at,
       df.attempts AS failed_attempts, df.retry_after AS retry_after`;

export const staleThreads = (db: Database, limit = 50): StaleThread[] =>
  db
    .query(
      `SELECT ${STALE_COLUMNS}
       ${STALE_FROM_WHERE}
       ORDER BY t.last_ts DESC
       LIMIT $limit`,
    )
    .all({ $version: DIGEST_PROMPT_VERSION, $limit: limit }) as StaleThread[];

// What a drain takes: the stale threads that have settled and are not backing off
// after a failure.
export const drainableThreads = (db: Database, limit: number, now: number): StaleThread[] =>
  db
    .query(
      `SELECT ${STALE_COLUMNS}
       ${STALE_FROM_WHERE}
         AND ${DRAINABLE}
       ORDER BY t.last_ts DESC
       LIMIT $limit`,
    )
    .all({ $version: DIGEST_PROMPT_VERSION, $limit: limit, ...drainWindow(now) }) as StaleThread[];

// Stale but left for later by a drain, so an empty drain can say why.
export const countHeldBackThreads = (db: Database, now: number): number =>
  (
    db
      .query(
        `SELECT COUNT(*) AS c ${STALE_FROM_WHERE}
           AND NOT (${DRAINABLE})`,
      )
      .get({ $version: DIGEST_PROMPT_VERSION, ...drainWindow(now) }) as { c: number }
  ).c;

export const countStaleThreads = (db: Database): number =>
  (
    db.query(`SELECT COUNT(*) AS c ${STALE_FROM_WHERE}`).get({
      $version: DIGEST_PROMPT_VERSION,
    }) as { c: number }
  ).c;

export interface SummaryCoverage {
  threads: number;
  // Joined to threads: a relink can move a root, and a summary keyed on a stale
  // id is not coverage (`relevant` never reaches it through the view).
  summarized: number;
  stale: number;
  // Stale threads with a failed attempt on record.
  failing: number;
}

export const summaryCoverage = (db: Database): SummaryCoverage => ({
  threads: countThreads(db),
  summarized: (
    db
      .query(`SELECT COUNT(*) AS c FROM summaries su JOIN threads t ON t.id = su.root_session_id`)
      .get() as { c: number }
  ).c,
  stale: countStaleThreads(db),
  failing: (
    db
      .query(`SELECT COUNT(*) AS c ${STALE_FROM_WHERE} AND df.root_session_id IS NOT NULL`)
      .get({ $version: DIGEST_PROMPT_VERSION }) as { c: number }
  ).c,
});
