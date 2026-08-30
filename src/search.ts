import type { Database } from "bun:sqlite";
import { dedupedHitWindow, escapeLike, type RankedMessageHit, rankedMessageHits } from "./fts.ts";
import {
  attachThreadDisplay,
  messageOrdinal,
  type ThreadDisplay,
  threadDisplay,
  threadOnBranch,
} from "./thread.ts";

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

export interface SearchOpts {
  project?: string;
  branch?: string;
  since?: string;
  role?: string;
  prose?: boolean;
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
  const filters: { sql: string; params: string[] }[] = [];
  if (opts.project) {
    filters.push({
      sql: "t.project_path LIKE '%' || ? || '%' ESCAPE '\\'",
      params: [escapeLike(opts.project)],
    });
  }
  if (opts.branch) {
    filters.push({ sql: threadOnBranch("s.root_session_id"), params: [escapeLike(opts.branch)] });
  }
  if (opts.since) {
    filters.push({ sql: "m.ts >= ?", params: [opts.since] });
  }
  if (opts.role) {
    filters.push({ sql: "m.role = ?", params: [opts.role] });
  }
  if (opts.prose) {
    // Prefix heuristic: a tool-only message always opens with "[tool_" as
    // flattenContent renders it. A message that opens with prose and calls a
    // tool further down is kept on purpose.
    filters.push({ sql: "m.text NOT LIKE '[tool\\_%' ESCAPE '\\'", params: [] });
  }

  // The ordinal is deliberately not computed in the hit query (a thread-wide
  // COUNT per matched row); messageOrdinal runs once per KEPT hit below.
  const collect = (match: string): RankedMessageHit[] => {
    const fetch = (windowSize: number): RankedMessageHit[] =>
      rankedMessageHits(db, match, { limit: windowSize, snippetTokens: 12, filters });
    return opts.all
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

  // No rollup row (sessions rows gone) falls back to what the matched session
  // carries, rather than dropping the hit.
  const fallback = (hit: RankedMessageHit): ThreadDisplay =>
    threadDisplay({
      project_path: hit.session_project_path,
      provider: hit.session_provider,
      model: hit.session_model,
      title: hit.session_title,
    });

  // A search hit is a message, so it shows the message's own ts and branch and
  // leaves the thread's last_ts out.
  return attachThreadDisplay(db, kept, fallback).map(({ hit, display }) => ({
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
