import type { Database } from "bun:sqlite";
import { toMatchQuery } from "../fts.ts";
import { attachThreadDisplay, noThreadDisplay, rootOf, threadLastTs } from "../thread.ts";
import { DIGEST_PROMPT_VERSION } from "./prompt.ts";

// Design notes: docs/architecture.md ("Digest").

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

// `coversLastTs` is the thread's last_ts when the transcript was rendered:
// messages indexed during the model call must stay stale rather than be stamped
// as covered. Omitted, the current last_ts is used (right for `digest write`).
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

export interface SummaryRootHit {
  root: string;
  snippet: string;
  score: number;
  last_ts: string | null;
  git_root: string | null;
  project_path: string | null;
}

// LEFT JOIN so a summary whose sessions rows are gone still returns its snippet;
// throws on a malformed MATCH so each caller keeps its own fallback.
export const searchSummaryRoots = (
  db: Database,
  match: string,
  limit: number,
  snippetTokens: number,
): SummaryRootHit[] =>
  db
    .query(
      `SELECT s.root_session_id AS root,
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
    .all(snippetTokens, match, limit) as SummaryRootHit[];

export interface SummaryHit {
  id: string;
  last_ts: string | null;
  project_path: string | null;
  provider: string | null;
  model: string | null;
  title: string | null;
  snippet: string;
}

export const searchSummaries = (db: Database, query: string, limit = 10): SummaryHit[] => {
  const match = toMatchQuery(query);
  if (!match) return [];

  let rows: SummaryRootHit[];
  try {
    rows = searchSummaryRoots(db, match, limit, 12);
  } catch {
    return [];
  }

  return attachThreadDisplay(db, rows, {
    fallback: noThreadDisplay,
    build: (row, display) => ({ id: row.root, ...display, snippet: row.snippet }),
  });
};
