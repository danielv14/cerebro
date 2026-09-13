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

// What every ranked hit carries, whichever FTS table produced it. Both tiers of
// `relevant` rank against this one shape: the message-hit query below and the
// summary-hit query in src/digest/store.ts are two adapters at the same seam. It
// stays one type so adding a ranking input (a branch boost, say) is one field and
// two queries rather than two hit types and an untyped consumer.
export interface RankedHit {
  // The thread the hit belongs to. `id` means the thread on every hit and every
  // listing row. Coalesced to the session itself when root_session_id is NULL,
  // so a not-yet-relinked hit is never silently dropped.
  id: string;
  snippet: string;
  // bm25; lower = more relevant.
  score: number;
  // NULL when the thread has no rollup row (LEFT JOIN on purpose: a hit must
  // survive its sessions rows being gone).
  last_ts: string | null;
  git_root: string | null;
  project_path: string | null;
}

export interface RankedMessageHit extends RankedHit {
  // The matched message's own rowid, which is what it is; the thread is `id`.
  message_id: number;
  session_id: string;
  ts: string | null;
  role: string;
  // The message's own branch, which search shows instead of the thread's.
  session_git_branch: string | null;
}

// `rootExpr` is a codebase literal; the branch fragment stays a bound `?`,
// LIKE-escaped by the caller.
export const threadOnBranch = (rootExpr: string): string =>
  `${rootExpr} IN (SELECT root_session_id FROM sessions ` +
  `WHERE git_branch LIKE '%' || ? || '%' ESCAPE '\\')`;

// What a caller can narrow a ranked hit by. Named filters rather than SQL, so the
// aliases the predicates are written against (m = message, s = session,
// t = rollup) stay private to this module and renaming one cannot break a caller
// at runtime only.
export interface HitFilters {
  // Substring of the thread's project path.
  project?: string;
  // Substring of a branch any of the thread's sessions was recorded on.
  branch?: string;
  // ISO date; only messages at or after it.
  since?: string;
  role?: string;
  // Drop messages that are nothing but flattened tool plumbing.
  prose?: boolean;
}

const hitPredicates = (filters: HitFilters): { sql: string; params: (string | number)[] }[] => {
  const out: { sql: string; params: (string | number)[] }[] = [];
  if (filters.project) {
    out.push({
      sql: "t.project_path LIKE '%' || ? || '%' ESCAPE '\\'",
      params: [escapeLike(filters.project)],
    });
  }
  if (filters.branch) {
    out.push({ sql: threadOnBranch("s.root_session_id"), params: [escapeLike(filters.branch)] });
  }
  if (filters.since) out.push({ sql: "m.ts >= ?", params: [filters.since] });
  if (filters.role) out.push({ sql: "m.role = ?", params: [filters.role] });
  if (filters.prose) {
    // Prefix heuristic: a tool-only message always opens with "[tool_" as
    // flattenContent renders it. A message that opens with prose and then calls a
    // tool further down is kept on purpose.
    out.push({ sql: "m.text NOT LIKE '[tool\\_%' ESCAPE '\\'", params: [] });
  }
  return out;
};

export interface RankedHitWindow {
  limit: number;
  snippetTokens: number;
  filters?: HitFilters;
}

// Throws on a malformed MATCH so each caller keeps its own fallback.
export const rankedMessageHits = (
  db: Database,
  match: string,
  window: RankedHitWindow,
): RankedMessageHit[] => {
  const filters = hitPredicates(window.filters ?? {});
  const sql = `
    SELECT m.id AS message_id, m.session_id, m.ts, m.role,
           COALESCE(s.root_session_id, s.session_id) AS id,
           s.git_branch AS session_git_branch,
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

const bestHitPerThread = <T extends { id: string }>(
  hits: T[],
  rank: (hit: T, index: number) => number = (_, index) => index,
): T[] => {
  const byThread = new Map<string, { hit: T; rank: number }>();
  hits.forEach((hit, index) => {
    const hitRank = rank(hit, index);
    const existing = byThread.get(hit.id);
    if (!existing || hitRank < existing.rank) byThread.set(hit.id, { hit, rank: hitRank });
  });
  return [...byThread.values()].sort((a, b) => a.rank - b.rank).map((entry) => entry.hit);
};

const WINDOW_GROWTH = 4;
const WINDOW_ROUNDS = 3;

export interface DedupedWindow<T> {
  fetch: (size: number) => T[];
  targetThreads: number;
  minRows: number;
  rowsPerThread: number;
  // A caller on a latency path passes false to answer out of its first fetch.
  grow?: boolean;
  // Defaults to the incoming (bm25) order; relevance passes its decayed rank.
  rank?: (hit: T, index: number) => number;
}

export const dedupedHitWindow = <T extends { id: string }>({
  fetch,
  targetThreads,
  minRows,
  rowsPerThread,
  grow = true,
  rank,
}: DedupedWindow<T>): T[] => {
  const rounds = grow ? WINDOW_ROUNDS : 0;
  let size = Math.max(minRows, targetThreads * rowsPerThread);
  let rows = fetch(size);
  let kept = bestHitPerThread(rows, rank);
  // Grow only when genuinely exhausted: fewer threads than asked for AND a full
  // window came back, so deeper rows can still exist.
  for (
    let round = 0;
    round < rounds && kept.length < targetThreads && rows.length >= size;
    round++
  ) {
    size *= WINDOW_GROWTH;
    rows = fetch(size);
    kept = bestHitPerThread(rows, rank);
  }
  return kept;
};
