import type { Database } from "bun:sqlite";
import { type RankedHit, toMatchQuery } from "../fts.ts";
import { attachThreadIdentity, rootOf, type ThreadIdentity, threadLastTs } from "../thread.ts";
import { DIGEST_PROMPT_VERSION } from "./prompt.ts";

// Anchored at the start of the text, where CLI/API failures announce themselves;
// a real summary opening with one of these is not a plausible prompt output.
const SUMMARY_REJECT_PATTERNS: RegExp[] = [
  /^prompt is too long/i,
  /^api error/i,
  /^error:/i,
  /^execution error/i,
  /^credit balance is too low/i,
  /^invalid api key/i,
];

// The legitimate minimum is the ~50-char two-line empty-session form the prompt
// mandates; far below that is a fragment or an error.
export const SUMMARY_MIN_CHARS = 20;

export const rejectSummaryReason = (text: string): string | null => {
  if (text.length < SUMMARY_MIN_CHARS) {
    return `too short to be a summary (${text.length} chars, minimum ${SUMMARY_MIN_CHARS})`;
  }
  for (const pattern of SUMMARY_REJECT_PATTERNS) {
    if (pattern.test(text)) return "looks like an error message, not a summary";
  }
  return null;
};

export const writeSummary = (
  db: Database,
  sessionId: string,
  summary: string,
  model: string | null = null,
  coversLastTs?: string | null,
): string => {
  const root = rootOf(db, sessionId);
  const sourceLastTs = coversLastTs === undefined ? threadLastTs(db, root) : coversLastTs;

  db.query(
    `INSERT INTO summaries (root_session_id, summary, prompt_version, model, summarized_at, source_last_ts)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(root_session_id) DO UPDATE SET
       summary        = excluded.summary,
       prompt_version = excluded.prompt_version,
       model          = excluded.model,
       summarized_at  = excluded.summarized_at,
       source_last_ts = excluded.source_last_ts`,
  ).run(root, summary, DIGEST_PROMPT_VERSION, model, new Date().toISOString(), sourceLastTs);
  db.query("DELETE FROM digest_failures WHERE root_session_id = ?").run(root);

  return root;
};

// The first retry lands on the reconciler's next 6-hourly run; each further
// failure doubles the wait, up to a week.
const RETRY_BASE_MS = 6 * 60 * 60 * 1000;
const RETRY_MAX_MS = 7 * 24 * 60 * 60 * 1000;

export const retryDelayMs = (attempts: number): number =>
  Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);

export const recordDigestFailure = (
  db: Database,
  root: string,
  error: string,
  now: number,
): void => {
  const previous = db
    .query("SELECT attempts FROM digest_failures WHERE root_session_id = ?")
    .get(root) as { attempts: number } | null;
  const attempts = (previous?.attempts ?? 0) + 1;
  db.query(
    `INSERT INTO digest_failures (root_session_id, attempts, last_error, failed_at, retry_after)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(root_session_id) DO UPDATE SET
       attempts    = excluded.attempts,
       last_error  = excluded.last_error,
       failed_at   = excluded.failed_at,
       retry_after = excluded.retry_after`,
  ).run(
    root,
    attempts,
    error,
    new Date(now).toISOString(),
    new Date(now + retryDelayMs(attempts)).toISOString(),
  );
};

// Keys with no sessions row are left alone: a summary outlives its sessions.
export const reattachSummaries = (db: Database): void => {
  const orphans = db
    .query(
      `SELECT su.root_session_id AS old, s.root_session_id AS root, su.summarized_at
       FROM summaries su
       JOIN sessions s ON s.session_id = su.root_session_id
       WHERE s.root_session_id IS NOT NULL AND s.root_session_id <> su.root_session_id
       ORDER BY su.summarized_at DESC`,
    )
    .all() as { old: string; root: string; summarized_at: string }[];
  const current = db.query("SELECT summarized_at FROM summaries WHERE root_session_id = ?");
  const move = db.query(
    "UPDATE summaries SET root_session_id = ?, source_last_ts = NULL WHERE root_session_id = ?",
  );
  const drop = db.query("DELETE FROM summaries WHERE root_session_id = ?");
  for (const orphan of orphans) {
    const existing = current.get(orphan.root) as { summarized_at: string } | null;
    if (existing && existing.summarized_at >= orphan.summarized_at) {
      drop.run(orphan.old);
      continue;
    }
    if (existing) drop.run(orphan.root);
    move.run(orphan.root, orphan.old);
  }
  db.run(
    `DELETE FROM digest_failures WHERE root_session_id IN (
       SELECT session_id FROM sessions
       WHERE root_session_id IS NOT NULL AND root_session_id <> session_id)`,
  );
};

export interface StoredSummary {
  root_session_id: string;
  summary: string;
  prompt_version: number;
  model: string | null;
  summarized_at: string;
  source_last_ts: string | null;
}

export const getSummary = (db: Database, sessionId: string): StoredSummary | null =>
  db
    .query("SELECT * FROM summaries WHERE root_session_id = ?")
    .get(rootOf(db, sessionId)) as StoredSummary | null;

// LEFT JOIN so a summary whose sessions rows are gone still returns its snippet;
// throws on a malformed MATCH so each caller keeps its own fallback.
export const searchSummaryRoots = (
  db: Database,
  match: string,
  limit: number,
  snippetTokens: number,
): RankedHit[] =>
  db
    .query(
      `SELECT s.root_session_id AS id,
              snippet(summaries_fts, 0, '[', ']', ' … ', ?) AS snippet,
              bm25(summaries_fts) AS score,
              t.last_ts, t.git_root, t.project_path
       FROM summaries_fts
       JOIN summaries s ON s.rowid = summaries_fts.rowid
       LEFT JOIN threads t ON t.id = s.root_session_id
       WHERE summaries_fts MATCH ?
       ORDER BY bm25(summaries_fts)
       LIMIT ?`,
    )
    .all(snippetTokens, match, limit) as RankedHit[];

export interface SummaryHit extends ThreadIdentity {
  snippet: string;
}

export const searchSummaries = (db: Database, query: string, limit = 10): SummaryHit[] => {
  const match = toMatchQuery(query);
  if (!match) return [];

  let rows: RankedHit[];
  try {
    rows = searchSummaryRoots(db, match, limit, 12);
  } catch {
    return [];
  }

  return attachThreadIdentity(db, rows).map(({ hit, identity }) => ({
    ...identity,
    snippet: hit.snippet,
  }));
};
