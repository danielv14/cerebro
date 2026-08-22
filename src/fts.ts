import type { Database } from "bun:sqlite";
import { eng, removeStopwords, swe } from "stopword";

// The SQL/FTS query-language utilities live with the FTS layer: every LIKE built
// from user input and every MATCH built from prose goes through here.

// Escape LIKE wildcards in user-supplied fragments so `_` and `%` match literally.
// Every LIKE built from user input pairs this with an explicit ESCAPE '\' clause.
export const escapeLike = (fragment: string): string =>
  fragment.replace(/[\\%_]/g, (ch) => `\\${ch}`);

// Turn a natural-language prompt into an FTS5 OR-of-tokens query, ranked by bm25.
// Implicit-AND (the default) would require every word to co-occur and usually
// return nothing for a prose prompt. Common Swedish/English words are dropped via
// the `stopword` package (not a hand-kept list) so a conversational prompt does
// not match unrelated threads on filler like "vi/kan/den/the/and".
export const toMatchQuery = (text: string): string | null => {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const meaningful = removeStopwords(tokens, [...swe, ...eng]);
  const unique = [...new Set(meaningful)].slice(0, 40);
  if (unique.length === 0) return null;
  return unique.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
};

// The message-FTS layer: one owner of the ranked-hit query shape over
// messages_fts. `search` and `relevantThreads` used to carry their own copy of
// the same FTS-join-sessions-join-rollup query and their own spelling of "keep
// the best hit per thread root", which is exactly how #119/#127 happened: the two
// paths disagreed about the same thread and the fix had to land twice. The join
// and the dedup live here once, along with the growth policy that keeps a deep
// window from starving a thread; what a caller keeps for itself is the ranking
// function, the size of its first fetch, and display hydration.

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
  // Extra predicates composed by the caller against the query's fixed aliases
  // (m = matched message, s = its session row, t = the thread rollup). Each
  // predicate carries its own bound values, so a fragment and its params cannot
  // drift apart by ordering; the ANDing and the flattening are owned here. The
  // sql fragments are literals the codebase owns; user input stays in params.
  filters?: { sql: string; params: (string | number)[] }[];
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

// The best-per-thread-root rule, expressed exactly once: keep the lowest-ranked
// hit per root, returned best-first. Module-private, because a window is the only
// sensible unit to dedup: dedupedHitWindow below is what callers reach for.
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

// Geometric growth for a deduped hit window, shared by search and relevance. A
// fixed window is not enough on its own: one chatty thread can own every row in it
// and starve the threads ranked below, so an exhausted window is re-fetched deeper
// and the dedup redone from the top. One deep fetch rather than LIMIT/OFFSET
// paging: `ORDER BY bm25(...) LIMIT n` uses a bounded top-N sorter, so a deeper n
// is nearly free, while every extra page re-ranks the whole match set and pays that
// cost again (#81).
const WINDOW_GROWTH = 4;
const WINDOW_ROUNDS = 3;

export interface DedupedWindow<T> {
  // Fetches the top `size` rows, best-first, under a MATCH the caller has already
  // resolved. Called once per round.
  fetch: (size: number) => T[];
  // Distinct thread roots wanted. Growth stops once the window holds this many.
  targetRoots: number;
  // The first fetch is `max(minRows, targetRoots * rowsPerRoot)`: enough rows to
  // hold the roots asked for at an assumed per-thread density, never below a floor
  // that covers a small archive in one go. Both numbers are the caller's tuning:
  // search over-fetches deep because an explicit query can afford it, relevance
  // stays shallow because it runs on the prompt hot path.
  minRows: number;
  rowsPerRoot: number;
  // Whether an exhausted window may grow. A caller on a latency path passes false
  // to answer out of its first fetch rather than pay a deeper query.
  grow?: boolean;
  // Rank for the dedup. Defaults to the incoming order, which is what a caller
  // wants when the rows arrive sorted by bm25; relevance passes its decayed and
  // boosted rank instead, so the hit kept per thread is the one it ranks on.
  rank?: (hit: T, index: number) => number;
}

// The best hit per thread root over a window deep enough to hold `targetRoots` of
// them. Truncation stays the caller's: search slices to its limit, relevance fills
// the slots its summary tier left open.
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
