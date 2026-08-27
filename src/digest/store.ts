import type { Database } from "bun:sqlite";
import { toMatchQuery } from "../fts.ts";
import { hydrateThreadMeta, rootOf, threadLastTs } from "../thread.ts";
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
// stamping the current prompt version and the last_ts the summary covers (so later
// activity makes it stale). The FTS triggers keep summaries_fts in sync. Returns
// the root id the summary was attributed to.
//
// `coversLastTs` is the thread's last_ts *as it was when the transcript was
// rendered*. Pass it whenever the summary was produced from a snapshot taken
// earlier: a model call takes minutes, and messages indexed in the meantime would
// otherwise be stamped as covered by a summary that never saw them, leaving them
// invisible to the staleness predicate until the prompt version is bumped. Omit it
// and the thread's current last_ts is used, which is right for `digest write`,
// where the caller just produced the summary from what is there now.
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
  // bm25 of the summary match plus the thread's latest activity and repo, so
  // `relevant` can recency-weight the tier and boost same-repo threads. `digest
  // search` ignores all four.
  score: number;
  last_ts: string | null;
  git_root: string | null;
  project_path: string | null;
}

// The curated-summary FTS search, ranked by bm25, for an already-tokenized MATCH
// query. Owned here, next to the writes: the module that stores a summary reads it
// back too, instead of the seam running through the middle of the `summaries` table.
// The single owner of the summaries_fts query shape, so `relevant`'s summary tier and
// `digest search` cannot drift on the query, the join, or the snippet markup.
// `snippetTokens` is a parameter because the two callers surface different amounts of
// context (relevant is compact, digest search is roomier). The thread rollup (last_ts
// and the repo fields) is joined in from the `threads` view, left so a summary whose
// sessions rows are gone still returns its snippet. Throws on a malformed MATCH so
// each caller keeps its own fallback (relevant falls through to raw transcripts;
// digest search returns empty).
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
  // The thread's source and model, carried in --json only, from the same rollup
  // every other listing reads.
  provider: string | null;
  model: string | null;
  title: string | null;
  snippet: string;
}

// Full-text search over the curated summaries (not the raw transcripts). The prose
// prompt is turned into an OR-of-tokens query like `relevant`, so a topical query
// surfaces the best-matching summaries without requiring every word to co-occur.
export const searchSummaries = (db: Database, query: string, limit = 10): SummaryHit[] => {
  const match = toMatchQuery(query);
  if (!match) return [];

  let rows: SummaryRootHit[];
  try {
    rows = searchSummaryRoots(db, match, limit, 12);
  } catch {
    return [];
  }

  const metaByRoot = hydrateThreadMeta(
    db,
    rows.map((row) => row.root),
  );
  return rows.map((row) => {
    const meta = metaByRoot.get(row.root);
    return {
      id: row.root,
      last_ts: meta?.last_ts ?? null,
      project_path: meta?.project_path ?? null,
      provider: meta?.provider ?? null,
      model: meta?.model ?? null,
      title: meta?.title ?? null,
      snippet: row.snippet,
    };
  });
};
