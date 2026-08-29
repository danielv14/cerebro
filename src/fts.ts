import type { Database } from "bun:sqlite";
import { eng, removeStopwords, swe } from "stopword";

// The FTS layer: query-language utilities, the ranked-hit query shape over
// messages_fts, and the shared dedup-and-grow window. Design notes:
// docs/architecture.md ("FTS layer").

// Every LIKE built from user input pairs this with an explicit ESCAPE '\' clause.
export const escapeLike = (fragment: string): string =>
  fragment.replace(/[\\%_]/g, (ch) => `\\${ch}`);

// OR-of-tokens rather than FTS5's implicit AND, which would require every word to
// co-occur and usually return nothing for a prose prompt. Stopwords are dropped so
// a conversational prompt does not match unrelated threads on filler.
export const toMatchQuery = (text: string): string | null => {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const meaningful = removeStopwords(tokens, [...swe, ...eng]);
  const unique = [...new Set(meaningful)].slice(0, 40);
  if (unique.length === 0) return null;
  return unique.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
};

export interface RankedMessageHit {
  id: number;
  session_id: string;
  // Coalesced to the session itself when root_session_id is NULL (a not-yet-
  // relinked session), so a rootless hit is never silently dropped.
  root: string;
  ts: string | null;
  role: string;
  // The matched message's own session row: display fallbacks for a thread whose
  // rollup row is gone.
  session_project_path: string | null;
  session_git_branch: string | null;
  session_title: string | null;
  session_provider: string | null;
  session_model: string | null;
  snippet: string;
  // bm25; lower = more relevant.
  score: number;
  // The thread rollup, NULL when the thread has no rollup row (LEFT JOIN on
  // purpose: a hit must survive its sessions rows being gone).
  last_ts: string | null;
  git_root: string | null;
  project_path: string | null;
}

export interface RankedHitWindow {
  limit: number;
  snippetTokens: number;
  // Extra predicates against the query's fixed aliases (m = matched message, s =
  // its session row, t = the thread rollup). The sql fragments are literals the
  // codebase owns; user input stays in params.
  filters?: { sql: string; params: (string | number)[] }[];
}

// Throws on a malformed MATCH so each caller keeps its own fallback (search retries
// a sanitized phrase query, relevance falls back to an empty tier).
export const rankedMessageHits = (
  db: Database,
  match: string,
  window: RankedHitWindow,
): RankedMessageHit[] => {
  const filters = window.filters ?? [];
  const sql = `
    SELECT m.id, m.session_id, m.ts, m.role,
           COALESCE(s.root_session_id, s.session_id) AS root,
           s.project_path AS session_project_path,
           s.git_branch   AS session_git_branch,
           s.title        AS session_title,
           s.provider     AS session_provider,
           s.model        AS session_model,
           snippet(messages_fts, 0, '[', ']', ' … ', ?) AS snippet,
           bm25(messages_fts) AS score,
           t.last_ts, t.git_root, t.project_path
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.rowid
    JOIN sessions s ON s.session_id = m.session_id
    LEFT JOIN threads t ON t.id = s.root_session_id
    WHERE messages_fts MATCH ?
    ${filters.map((filter) => `AND ${filter.sql}`).join("\n    ")}
    ORDER BY bm25(messages_fts)
    LIMIT ?`;
  return db
    .query(sql)
    .all(
      window.snippetTokens,
      match,
      ...filters.flatMap((filter) => filter.params),
      window.limit,
    ) as RankedMessageHit[];
};

// Keep the lowest-ranked hit per root, returned best-first.
const bestHitPerRoot = <T extends { root: string }>(
  hits: T[],
  rank: (hit: T, index: number) => number = (_, index) => index,
): T[] => {
  const byRoot = new Map<string, { hit: T; rank: number }>();
  hits.forEach((hit, index) => {
    const hitRank = rank(hit, index);
    const existing = byRoot.get(hit.root);
    if (!existing || hitRank < existing.rank) byRoot.set(hit.root, { hit, rank: hitRank });
  });
  return [...byRoot.values()].sort((a, b) => a.rank - b.rank).map((entry) => entry.hit);
};

// One chatty thread can own every row of a fixed window and starve the threads
// ranked below, so an exhausted window is re-fetched deeper (one deep fetch, not
// LIMIT/OFFSET paging: ORDER BY bm25 LIMIT n uses a bounded top-N sorter, while
// every extra page re-ranks the whole match set, #81).
const WINDOW_GROWTH = 4;
const WINDOW_ROUNDS = 3;

export interface DedupedWindow<T> {
  // Fetches the top `size` rows, best-first. Called once per round.
  fetch: (size: number) => T[];
  // Distinct thread roots wanted. Growth stops once the window holds this many.
  targetRoots: number;
  // The first fetch is max(minRows, targetRoots * rowsPerRoot); both numbers are
  // the caller's tuning.
  minRows: number;
  rowsPerRoot: number;
  // A caller on a latency path passes false to answer out of its first fetch.
  grow?: boolean;
  // Rank for the dedup. Defaults to the incoming (bm25) order; relevance passes
  // its decayed and boosted rank instead.
  rank?: (hit: T, index: number) => number;
}

// The best hit per thread root over a window deep enough to hold `targetRoots` of
// them. Truncation stays the caller's.
export const dedupedHitWindow = <T extends { root: string }>({
  fetch,
  targetRoots,
  minRows,
  rowsPerRoot,
  grow = true,
  rank,
}: DedupedWindow<T>): T[] => {
  const rounds = grow ? WINDOW_ROUNDS : 0;
  let size = Math.max(minRows, targetRoots * rowsPerRoot);
  let rows = fetch(size);
  let kept = bestHitPerRoot(rows, rank);
  // Grow only when the window was genuinely exhausted: fewer distinct roots than
  // asked for AND a full window came back, so deeper rows can still exist.
  for (let round = 0; round < rounds && kept.length < targetRoots && rows.length >= size; round++) {
    size *= WINDOW_GROWTH;
    rows = fetch(size);
    kept = bestHitPerRoot(rows, rank);
  }
  return kept;
};
