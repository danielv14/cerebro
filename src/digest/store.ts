import type { Database } from "bun:sqlite";
import { searchSummaryRoots, threadMeta, toMatchQuery } from "../query.ts";
import { rootOf, threadLastTs } from "../thread.ts";
import { DIGEST_PROMPT_VERSION } from "./prompt.ts";

// Failure output that must never be stored as a summary. The hooks already gate on
// the claude -p exit code, but the storage contract itself is the last line of
// defense: a past incident stored a "Prompt is too long" error as a summary via a
// pipeline that skipped the guard. Patterns match the *start* of the text, where
// CLI/API failures announce themselves; a real summary opening with one of these
// phrases is not a plausible output of the digest prompt.
const SUMMARY_REJECT_PATTERNS: RegExp[] = [
  /^prompt is too long/i,
  /^api error/i,
  /^error:/i,
  /^execution error/i,
  /^credit balance is too low/i,
  /^invalid api key/i,
];

// The legitimate minimum is the two-line empty-session form the prompt mandates
// ("(No substantive session content.)" + "Keywords: (none)"), ~50 chars; anything
// far below that is a fragment or an error, not a summary.
export const SUMMARY_MIN_CHARS = 20;

// Why a summary text is unacceptable to store, or null when it is fine. Pure, so
// the CLI boundary and tests share one rule set.
export const rejectSummaryReason = (text: string): string | null => {
  if (text.length < SUMMARY_MIN_CHARS) {
    return `too short to be a summary (${text.length} chars, minimum ${SUMMARY_MIN_CHARS})`;
  }
  for (const pattern of SUMMARY_REJECT_PATTERNS) {
    if (pattern.test(text)) return "looks like an error message, not a summary";
  }
  return null;
};

// Store a summary for the thread that owns `sessionId`. Upserts on the thread root,
// stamping the current prompt version and the thread's current last_ts (so later
// activity makes it stale). The FTS triggers keep summaries_fts in sync. Returns
// the root id the summary was attributed to.
export const writeSummary = (
  db: Database,
  sessionId: string,
  summary: string,
  model: string | null = null,
): string => {
  const root = rootOf(db, sessionId);
  const sourceLastTs = threadLastTs(db, root);

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

  return root;
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

export interface SummaryHit {
  id: string;
  last_ts: string | null;
  project_path: string | null;
  title: string | null;
  snippet: string;
}

// Full-text search over the curated summaries (not the raw transcripts). The prose
// prompt is turned into an OR-of-tokens query like `relevant`, so a topical query
// surfaces the best-matching summaries without requiring every word to co-occur.
export const searchSummaries = (db: Database, query: string, limit = 10): SummaryHit[] => {
  const match = toMatchQuery(query);
  if (!match) return [];

  let rows: { root: string; snippet: string }[];
  try {
    rows = searchSummaryRoots(db, match, limit, 12);
  } catch {
    return [];
  }

  return rows.map((row) => {
    const meta = threadMeta(db, row.root);
    return {
      id: row.root,
      last_ts: meta?.last_ts ?? null,
      project_path: meta?.project_path ?? null,
      title: meta?.title ?? null,
      snippet: row.snippet,
    };
  });
};
