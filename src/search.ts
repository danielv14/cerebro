import type { Database } from "bun:sqlite";
import {
  dedupedHitWindow,
  type HitFilters,
  type RankedMessageHit,
  rankedMessageHits,
} from "./fts.ts";
import { attachThreadDisplay, messageOrdinal } from "./thread.ts";

// Filter semantics and design notes: docs/architecture.md ("Search").

export interface SearchHit {
  id: number;
  session_id: string;
  ts: string | null;
  role: string;
  project_path: string | null;
  git_branch: string | null;
  provider: string | null;
  model: string | null;
  title: string | null;
  snippet: string;
  // The same numbering `show` uses, so a hit can be jumped to with show --range.
  ordinal: number;
}

export interface SearchOpts extends HitFilters {
  // Every matching message instead of the best hit per thread.
  all?: boolean;
}

export const SEARCH_ROLES = ["user", "assistant"] as const;

const SEARCH_WINDOW_MIN_ROWS = 2000;
const SEARCH_WINDOW_ROWS_PER_ROOT = 50;

export const search = (
  db: Database,
  query: string,
  limit = 20,
  opts: SearchOpts = {},
): SearchHit[] => {
  const { all, ...filters } = opts;

  // The ordinal is deliberately not computed in the hit query (a thread-wide
  // COUNT per matched row); messageOrdinal runs once per KEPT hit below.
  const collect = (match: string): RankedMessageHit[] => {
    const fetch = (windowSize: number): RankedMessageHit[] =>
      rankedMessageHits(db, match, { limit: windowSize, snippetTokens: 12, filters });
    return all
      ? fetch(limit)
      : dedupedHitWindow({
          fetch,
          targetRoots: limit,
          minRows: SEARCH_WINDOW_MIN_ROWS,
          rowsPerRoot: SEARCH_WINDOW_ROWS_PER_ROOT,
        }).slice(0, limit);
  };

  // The retry wraps the whole window: only the first fetch can fail on syntax,
  // because a query FTS5 accepted once stays valid at every window size.
  let kept: RankedMessageHit[];
  try {
    kept = collect(query);
  } catch {
    const sanitized = query
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => `"${token.replace(/"/g, '""')}"`)
      .join(" ");
    if (!sanitized) return [];
    kept = collect(sanitized);
  }

  // A search hit is a message, so it shows the message's own ts and branch and
  // leaves the thread's last_ts out.
  return attachThreadDisplay(db, kept).map(({ hit, display }) => ({
    id: hit.id,
    session_id: hit.session_id,
    ts: hit.ts,
    role: hit.role,
    project_path: display.project_path,
    git_branch: hit.session_git_branch,
    provider: display.provider,
    model: display.model,
    title: display.title,
    snippet: hit.snippet,
    ordinal: messageOrdinal(db, hit.root, hit.id),
  }));
};
