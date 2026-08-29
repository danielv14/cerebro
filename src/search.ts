import type { Database } from "bun:sqlite";
import { dedupedHitWindow, escapeLike, type RankedMessageHit, rankedMessageHits } from "./fts.ts";
import { hydrateThreadMeta, messageOrdinal, threadOnBranch } from "./thread.ts";

// Full-text search as the `search` command runs it. Filter semantics and design
// notes: docs/architecture.md ("Search").

export interface SearchHit {
  id: number;
  session_id: string;
  ts: string | null;
  role: string;
  // The thread's, from the rollup, so a hit agrees with every other surface.
  project_path: string | null;
  // The matched message's own session's (approximate for a session that switched
  // branches mid-way).
  git_branch: string | null;
  provider: string | null;
  model: string | null;
  title: string | null;
  snippet: string;
  // The same numbering `show` uses, so a hit can be jumped to with show --range.
  ordinal: number;
}

export interface SearchOpts {
  // Thread-level, matched on the rollup's project_path (same value `sessions
  // --project` matches on).
  project?: string;
  // Any-session, not root-preferring: see threadOnBranch.
  branch?: string;
  // Per message, deliberately: a property of the turn, not the thread.
  since?: string;
  role?: string;
  // Drop messages that are nothing but flattened tool plumbing.
  prose?: boolean;
  // true = every matching message; false/absent = the best hit per thread.
  all?: boolean;
}

// classify() already drops every other role before insert.
export const SEARCH_ROLES = ["user", "assistant"] as const;

// An explicit query can afford a deep first window; 2000 rows covers any realistic
// archive in one fetch.
const SEARCH_WINDOW_MIN_ROWS = 2000;
const SEARCH_WINDOW_ROWS_PER_ROOT = 50;

export const search = (
  db: Database,
  query: string,
  limit = 20,
  opts: SearchOpts = {},
): SearchHit[] => {
  const filters: { sql: string; params: string[] }[] = [];
  // Filtering on the matched message's own session row instead would silently drop
  // every hit in a resume whose lines carry no cwd, or a cwd that differs from the
  // root's (#86). The rollup join is a LEFT JOIN, so a NULL t.project_path fails
  // the LIKE and drops the hit, as the old inner join did.
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
    // A prefix heuristic: a tool-only message always starts with "[tool_" as
    // flattenContent renders it. A message that opens with prose and calls a tool
    // further down is kept on purpose. No LIKE parameter, so nothing to escape.
    filters.push({ sql: "m.text NOT LIKE '[tool\\_%' ESCAPE '\\'", params: [] });
  }

  // The ordinal is deliberately NOT computed in the hit query: it would run a
  // thread-wide COUNT for every matched row the sorter sees; messageOrdinal runs
  // once per *kept* hit below.
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

  // The retry wraps the whole window, not each fetch: only the first fetch can fail
  // on syntax, because a query FTS5 accepted once stays valid at every window size.
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

  // Title and project are the *thread's* (#120): a resumed thread usually splits
  // the two across its sessions, and reading the session row made `search` disagree
  // with the other surfaces. `ts` and `git_branch` stay the matched message's own.
  const metaByRoot = hydrateThreadMeta(db, [...new Set(kept.map((hit) => hit.root))]);

  return kept.map((hit) => {
    // A thread with no rollup row (its sessions rows are gone) falls back to what
    // the matched session carries, rather than dropping the hit.
    const meta = metaByRoot.get(hit.root);
    return {
      id: hit.id,
      session_id: hit.session_id,
      ts: hit.ts,
      role: hit.role,
      project_path: meta ? meta.project_path : hit.session_project_path,
      git_branch: hit.session_git_branch,
      provider: meta ? meta.provider : hit.session_provider,
      model: meta ? meta.model : hit.session_model,
      title: meta ? meta.title : hit.session_title,
      snippet: hit.snippet,
      ordinal: messageOrdinal(db, hit.root, hit.id),
    };
  });
};
