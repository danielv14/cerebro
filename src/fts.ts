import type { Database } from "bun:sqlite";
import { eng, removeStopwords, swe } from "stopword";
import { isToolText } from "./sources/claude-code-jsonl.ts";
import { type ThreadScope, threadScope } from "./thread.ts";

// A quoted FTS5 string is always valid syntax, whatever the token holds.
export const quoteFtsToken = (token: string): string => `"${token.replace(/"/g, '""')}"`;

// OR-of-tokens rather than FTS5's implicit AND, which returns nothing for prose.
export const toMatchQuery = (text: string): string | null => {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const meaningful = removeStopwords(tokens, [...swe, ...eng]);
  const unique = [...new Set(meaningful)].slice(0, 40);
  if (unique.length === 0) return null;
  return unique.map(quoteFtsToken).join(" OR ");
};

export interface RankedHit {
  // The thread, never the row the hit came from.
  id: string;
  snippet: string;
  // bm25; lower = more relevant.
  score: number;
  last_ts: string | null;
  git_root: string | null;
  project_path: string | null;
}

export interface RankedMessageHit extends RankedHit {
  message_id: number;
  session_id: string;
  ts: string | null;
  role: string;
  session_git_branch: string | null;
}

export interface HitFilters extends ThreadScope {
  since?: string;
  role?: string;
  prose?: boolean;
}

const hitPredicates = (filters: HitFilters): { sql: string; params: (string | number)[] }[] => {
  const out: { sql: string; params: (string | number)[] }[] = threadScope(filters, {
    root: "s.root_session_id",
    projectPath: "t.project_path",
  });
  if (filters.since) out.push({ sql: "m.ts >= ?", params: [filters.since] });
  if (filters.role) out.push({ sql: "m.role = ?", params: [filters.role] });
  if (filters.prose) {
    // A message that opens with prose and then calls a tool further down is kept
    // on purpose.
    out.push({ sql: `NOT ${isToolText("m.text")}`, params: [] });
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
           s.root_session_id AS id,
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
  grow?: boolean;
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
