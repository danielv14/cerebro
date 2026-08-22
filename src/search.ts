import type { Database } from "bun:sqlite";
import { dedupedHitWindow, escapeLike, type RankedMessageHit, rankedMessageHits } from "./fts.ts";
import { hydrateThreadMeta, messageOrdinal, threadOnBranch } from "./thread.ts";

// Full-text search over the raw transcripts, as the `search` command runs it:
// the user-facing filters, the sanitized-fallback MATCH handling, the size of the
// first over-fetch window, and display hydration. The query shape and the
// dedup-and-grow window live in the FTS layer (rankedMessageHits,
// dedupedHitWindow).

export interface SearchHit {
  id: number;
  session_id: string;
  ts: string | null;
  role: string;
  // The thread's project and title, from the `threads` rollup (#120), so a hit agrees
  // with every other surface no matter which session inside the thread it landed in.
  project_path: string | null;
  // The branch the matched message's own session was recorded on (a session stores
  // one branch, so this is approximate for a session that switched branches mid-way).
  git_branch: string | null;
  title: string | null;
  snippet: string;
  // 1-based position of the message within its thread's chronological order; the
  // same numbering `show` uses, so a hit can be jumped to with show --range.
  ordinal: number;
}

export interface SearchOpts {
  // Substring filter on the thread's project path (same semantics as sessions
  // --project). Goes through the `threads` rollup rather than the matched message's
  // own session row, which is what makes those two commands agree; see the join below.
  project?: string;
  // Substring filter on the git branch. Thread-level like `project`, but any-session
  // rather than root-preferring: a thread counts as touching a branch when ANY of its
  // sessions was recorded on it, because branch work often starts in a resume of a
  // thread whose root sat on master. The predicate itself is threadOnBranch
  // (thread.ts), shared with the thread listing.
  branch?: string;
  // ISO date/datetime cutoff: only messages with ts >= since (lexical compare works
  // because stored timestamps are ISO-8601). Per message, deliberately: unlike
  // `project` this is a property of the turn, not of the thread it belongs to.
  since?: string;
  // Only turns recorded with this role. A tool_result is a `user` turn, which is
  // why this pairs with `prose`.
  role?: string;
  // Drop messages that are nothing but flattened tool plumbing.
  prose?: boolean;
  // true = every matching message; false/absent = the best hit per thread, so one
  // chatty thread cannot occupy every result slot.
  all?: boolean;
}

// The roles a message can be recorded with, and so the accepted values of
// `search --role`. classify() already drops everything else before insert.
export const SEARCH_ROLES = ["user", "assistant"] as const;

// First over-fetch window for the deduped search: `max(2000, limit * 50)` rows.
// 2000 rows covers any realistic archive in one fetch, which is what an explicit
// query can afford. Growing it when it runs out before `limit` distinct thread
// roots are found is dedupedHitWindow's job.
const SEARCH_WINDOW_MIN = 2000;
const SEARCH_WINDOW_FACTOR = 50;

// FTS5 search ranked by bm25 (lower = more relevant). User queries are passed to
// MATCH verbatim so power users can use FTS operators; if that errors on stray
// syntax, fall back to a sanitized phrase query of the bare tokens. By default the
// results are deduplicated to the best (lowest-bm25) hit per thread root; --all
// disables that.
export const search = (
  db: Database,
  query: string,
  limit = 20,
  opts: SearchOpts = {},
): SearchHit[] => {
  const filters: { sql: string; params: string[] }[] = [];
  // The project filter is thread-level, so it reads the root's representative
  // project_path out of the `threads` rollup the hit query attaches, rather than
  // the matched message's own session row (#86). Filtering on the session would
  // silently drop every hit in a resume whose lines carry no cwd, or a cwd that
  // differs from the root's (a subdirectory, a worktree, a moved repo), even
  // though the thread belongs to the project. The view's root-preferring COALESCE
  // is the same value `sessions --project` matches on, so the two commands agree
  // by construction. The rollup join is a LEFT JOIN, so a NULL t.project_path
  // (no rollup row) fails the LIKE and drops the hit, exactly as the old inner
  // join did.
  if (opts.project) {
    filters.push({
      sql: "t.project_path LIKE '%' || ? || '%' ESCAPE '\\'",
      params: [escapeLike(opts.project)],
    });
  }
  if (opts.branch) {
    // Any-session, not root-preferring (see SearchOpts.branch), expressed relative to
    // the matched message's own session row: the same predicate `sessions --branch`
    // composes, owned by thread.ts.
    filters.push({ sql: threadOnBranch("s.root_session_id"), params: [escapeLike(opts.branch)] });
  }
  if (opts.since) {
    filters.push({ sql: "m.ts >= ?", params: [opts.since] });
  }
  if (opts.role) {
    filters.push({ sql: "m.role = ?", params: [opts.role] });
  }
  if (opts.prose) {
    // A prefix heuristic, not a parser: flattenContent renders a tool-only message
    // as "[tool_use:Name] ..." or "[tool_result] ...", so a message that is nothing
    // but plumbing always starts with "[tool_". The known miss is deliberate: a
    // message that opens with prose and calls a tool further down is kept, because
    // that prose is real content. No LIKE parameter, so nothing to escape.
    filters.push({ sql: "m.text NOT LIKE '[tool\\_%' ESCAPE '\\'", params: [] });
  }

  // The effective MATCH is decided on the first fetch and every later round reuses
  // it: a user query goes to MATCH verbatim so power users can use FTS operators,
  // and stray syntax falls back to a sanitized phrase query of the bare tokens.
  // Deciding once is why a growth round never pays the rejected query again.
  // `undefined` = not attempted yet, `null` = no usable query at all.
  let match: string | null | undefined;
  const fetchWindow = (windowSize: number): RankedMessageHit[] => {
    const run = (effective: string): RankedMessageHit[] =>
      rankedMessageHits(db, effective, { limit: windowSize, snippetTokens: 12, filters });
    if (match !== undefined) return match === null ? [] : run(match);
    try {
      const rows = run(query);
      match = query;
      return rows;
    } catch {
      match =
        query
          .split(/\s+/)
          .filter(Boolean)
          .map((token) => `"${token.replace(/"/g, '""')}"`)
          .join(" ") || null;
      return match === null ? [] : run(match);
    }
  };

  // The ordinal is deliberately NOT computed in the hit query: it would run a
  // thread-wide COUNT for every matched row the sorter sees; instead messageOrdinal
  // (thread.ts, the owner of thread ordering) runs once per *kept* hit below.
  const kept = opts.all
    ? fetchWindow(limit)
    : dedupedHitWindow({
        fetch: fetchWindow,
        target: limit,
        firstWindow: Math.max(SEARCH_WINDOW_MIN, limit * SEARCH_WINDOW_FACTOR),
      }).slice(0, limit);

  // Title and project are the *thread's*, read from the `threads` rollup rather than
  // the matched message's own session row (#120). A resumed thread usually splits the
  // two across its sessions (the root carries the cwd and no title event, the resume
  // carries the title and no cwd), so reading the session made `search` disagree with
  // sessions, recent, relevant and digest search on the same thread, and let a hit
  // that matched --project render its project as (unknown). Hydrated in one query
  // over the kept hits (at most `limit`), so display metadata has a single reader
  // shared with relevant and digest search. `ts` and `git_branch` stay the matched
  // message's own.
  const metaByRoot = hydrateThreadMeta(db, [...new Set(kept.map((hit) => hit.root))]);

  return kept.map((hit) => {
    // A thread with no rollup row (its sessions rows are gone) falls back to what the
    // matched session carries, rather than dropping the hit.
    const meta = metaByRoot.get(hit.root);
    return {
      id: hit.id,
      session_id: hit.session_id,
      ts: hit.ts,
      role: hit.role,
      project_path: meta ? meta.project_path : hit.session_project_path,
      git_branch: hit.session_git_branch,
      title: meta ? meta.title : hit.session_title,
      snippet: hit.snippet,
      ordinal: messageOrdinal(db, hit.root, hit.id),
    };
  });
};
