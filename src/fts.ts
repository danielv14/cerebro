import type { Database } from "bun:sqlite";
import { eng, removeStopwords, swe } from "stopword";

// Design notes: docs/architecture.md ("FTS layer").

// Every LIKE built from user input pairs this with an explicit ESCAPE '\' clause.
export const escapeLike = (fragment: string): string =>
  fragment.replace(/[\\%_]/g, (ch) => `\\${ch}`);

// OR-of-tokens rather than FTS5's implicit AND, which returns nothing for prose.
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
  // Coalesced to the session itself when root_session_id is NULL, so a
  // not-yet-relinked hit is never silently dropped.
  root: string;
  ts: string | null;
  role: string;
  session_project_path: string | null;
  session_git_branch: string | null;
  session_title: string | null;
  session_provider: string | null;
  session_model: string | null;
  snippet: string;
  // bm25; lower = more relevant.
  score: number;
  // NULL when the thread has no rollup row (LEFT JOIN on purpose: a hit must
  // survive its sessions rows being gone).
  last_ts: string | null;
  git_root: string | null;
  project_path: string | null;
}

export interface RankedHitWindow {
  limit: number;
  snippetTokens: number;
  // Predicates against the fixed aliases (m = message, s = session, t = rollup).
  // The sql fragments are codebase literals; user input stays in params.
  filters?: { sql: string; params: (string | number)[] }[];
}

// Throws on a malformed MATCH so each caller keeps its own fallback.
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

const WINDOW_GROWTH = 4;
const WINDOW_ROUNDS = 3;

export interface DedupedWindow<T> {
  fetch: (size: number) => T[];
  targetRoots: number;
  minRows: number;
  rowsPerRoot: number;
  // A caller on a latency path passes false to answer out of its first fetch.
  grow?: boolean;
  // Defaults to the incoming (bm25) order; relevance passes its decayed rank.
  rank?: (hit: T, index: number) => number;
}

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
  // Grow only when genuinely exhausted: fewer roots than asked for AND a full
  // window came back, so deeper rows can still exist.
  for (let round = 0; round < rounds && kept.length < targetRoots && rows.length >= size; round++) {
    size *= WINDOW_GROWTH;
    rows = fetch(size);
    kept = bestHitPerRoot(rows, rank);
  }
  return kept;
};
