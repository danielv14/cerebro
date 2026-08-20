import type { Database } from "bun:sqlite";

// The message-FTS layer: one owner of the ranked-hit query shape over
// messages_fts. `search` and `relevantThreads` used to carry their own copy of
// the same FTS-join-sessions-join-rollup query and their own spelling of "keep
// the best hit per thread root", which is exactly how #119/#127 happened: the two
// paths disagreed about the same thread and the fix had to land twice. The join
// and the dedup live here once; what a caller keeps for itself is policy (the
// ranking function, the over-fetch window, display hydration).

export interface RankedMessageHit {
  id: number;
  session_id: string;
  // The thread root, coalesced to the session itself when root_session_id is
  // NULL (a not-yet-relinked session), so both consumers key the dedup the same
  // way and a rootless hit is never silently dropped.
  root: string;
  ts: string | null;
  role: string;
  // The matched message's own session row: display fallbacks for a thread whose
  // rollup row is gone (its sessions rows were deleted).
  session_project_path: string | null;
  session_git_branch: string | null;
  session_title: string | null;
  snippet: string;
  // bm25 of the match; lower = more relevant. Callers rank on it (plain, or
  // decayed and boosted).
  score: number;
  // The thread rollup, from the `threads` view: root-preferring, so a resume
  // whose own row carries NULL git_root still ranks with the thread's repo. NULL
  // when the thread has no rollup row (LEFT JOIN on purpose: a hit must survive
  // its sessions rows being gone).
  last_ts: string | null;
  git_root: string | null;
  project_path: string | null;
}

export interface RankedHitWindow {
  // How many top-ranked rows to fetch (the caller's over-fetch window policy).
  limit: number;
  // Tokens of context in the FTS snippet (callers surface different amounts).
  snippetTokens: number;
  // Extra AND fragments composed by the caller against the query's fixed aliases
  // (m = matched message, s = its session row, t = the thread rollup), each `?`
  // bound from `params` in order. The fragments are literals the codebase owns;
  // user input stays in params.
  filters?: string[];
  params?: (string | number)[];
}

// Ranked message hits for an FTS5 MATCH, with the thread rollup attached. Throws
// on a malformed MATCH so each caller keeps its own fallback (search retries a
// sanitized phrase query, relevance falls back to an empty tier).
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
           snippet(messages_fts, 0, '[', ']', ' … ', ?) AS snippet,
           bm25(messages_fts) AS score,
           t.last_ts, t.git_root, t.project_path
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.rowid
    JOIN sessions s ON s.session_id = m.session_id
    LEFT JOIN threads t ON t.id = s.root_session_id
    WHERE messages_fts MATCH ?
    ${filters.join("\n    ")}
    ORDER BY bm25(messages_fts)
    LIMIT ?`;
  return db
    .query(sql)
    .all(window.snippetTokens, match, ...(window.params ?? []), window.limit) as RankedMessageHit[];
};

// The best-per-thread-root rule, expressed exactly once: keep the lowest-ranked
// hit per root, returned best-first. `rank` defaults to the incoming order, which
// is what a caller wants when the hits are already sorted (search's bm25 window);
// relevance passes its decayed-and-boosted rank instead. Truncation is the
// caller's (search slices to its limit, relevance fills remaining slots).
export const bestHitPerRoot = <T extends { root: string }>(
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
