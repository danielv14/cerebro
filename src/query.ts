import type { Database } from "bun:sqlite";
import { eng, removeStopwords, swe } from "stopword";
import { countThreads, threadOpeningPrompt } from "./thread.ts";

export interface SearchHit {
  id: number;
  session_id: string;
  ts: string | null;
  role: string;
  project_path: string | null;
  title: string | null;
  snippet: string;
}

export interface SearchOpts {
  // Substring filter on the thread's project path (same semantics as sessions --project).
  project?: string;
  // ISO date/datetime cutoff: only messages with ts >= since (lexical compare works
  // because stored timestamps are ISO-8601).
  since?: string;
  // true = every matching message (the historic behavior); false/absent = the best
  // hit per thread, so one chatty thread cannot occupy every result slot.
  all?: boolean;
}

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
  const filters: string[] = [];
  const filterParams: string[] = [];
  if (opts.project) {
    filters.push("AND s.project_path LIKE '%' || ? || '%' ESCAPE '\\'");
    filterParams.push(escapeLike(opts.project));
  }
  if (opts.since) {
    filters.push("AND m.ts >= ?");
    filterParams.push(opts.since);
  }

  // FTS5 aux functions (snippet, bm25) must live in the SELECT that owns the MATCH,
  // which rules out a window-function dedup in SQL. Instead: over-fetch the ranked
  // hits (bm25 order) and keep the first (= best) per thread root in JS, mirroring
  // how relevantThreads dedups its raw tier.
  const fetchLimit = opts.all ? limit : Math.max(200, limit * 10);
  const sql = `
    SELECT m.id, m.session_id, m.ts, m.role, s.project_path, s.title,
           s.root_session_id AS root,
           snippet(messages_fts, 0, '[', ']', ' … ', 12) AS snippet
    FROM messages_fts
    JOIN messages m  ON m.id = messages_fts.rowid
    JOIN sessions s  ON s.session_id = m.session_id
    WHERE messages_fts MATCH ?
    ${filters.join("\n    ")}
    ORDER BY bm25(messages_fts)
    LIMIT ?`;
  const stmt = db.query(sql);

  type RawHit = SearchHit & { root: string | null };
  const run = (match: string): RawHit[] => stmt.all(match, ...filterParams, fetchLimit) as RawHit[];

  let raw: RawHit[];
  try {
    raw = run(query);
  } catch {
    const sanitized = query
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => `"${token.replace(/"/g, '""')}"`)
      .join(" ");
    if (!sanitized) return [];
    raw = run(sanitized);
  }

  const strip = ({ root: _root, ...hit }: RawHit): SearchHit => hit;
  if (opts.all) return raw.map(strip);

  const seen = new Set<string>();
  const deduped: SearchHit[] = [];
  for (const hit of raw) {
    const key = hit.root ?? hit.session_id;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(strip(hit));
    if (deduped.length >= limit) break;
  }
  return deduped;
};

// Escape LIKE wildcards in user-supplied fragments so `_` and `%` match literally.
// Every LIKE built from user input pairs this with an explicit ESCAPE '\' clause.
export const escapeLike = (fragment: string): string =>
  fragment.replace(/[\\%_]/g, (ch) => `\\${ch}`);

export interface ThreadRow {
  id: string;
  last_ts: string | null;
  first_ts: string | null;
  msgs: number;
  sessions_in_thread: number;
  project_path: string | null;
  title: string | null;
  body_available: number;
}

// List logical threads (roots), most-recently-active first, from the `threads`
// view (see db.ts for the rollup). The project filter applies AFTER the rollup, on
// the thread's representative project_path, so a thread is matched on its root's
// project even when a resume's project_path is NULL or differs.
export const listThreads = (
  db: Database,
  opts: { project?: string; limit?: number } = {},
): ThreadRow[] => {
  const params: (string | number)[] = [];
  let where = "";
  if (opts.project) {
    where = "WHERE project_path LIKE '%' || ? || '%' ESCAPE '\\'";
    params.push(escapeLike(opts.project));
  }
  params.push(opts.limit ?? 30);

  return db
    .query(
      `SELECT id, last_ts, first_ts, msgs, sessions_in_thread, project_path, title, body_available
       FROM threads
       ${where}
       ORDER BY last_ts DESC
       LIMIT ?`,
    )
    .all(...params) as ThreadRow[];
};

// Recent threads scoped to one repo, for session-start context injection. Matches
// on the thread's git_root when the cwd is in a git repo, else on the exact
// project_path. `since` is an ISO cutoff (only threads active at or after it).
export const recentThreads = (
  db: Database,
  opts: { repoRoot?: string | null; cwd?: string; since: string; limit?: number },
): ThreadRow[] => {
  let repoFilter: string;
  const params: (string | number)[] = [opts.since];
  if (opts.repoRoot) {
    repoFilter = "git_root = ?";
    params.push(opts.repoRoot);
  } else if (opts.cwd) {
    repoFilter = "project_path = ?";
    params.push(opts.cwd);
  } else {
    return [];
  }
  params.push(opts.limit ?? 5);

  return db
    .query(
      `SELECT id, last_ts, first_ts, msgs, sessions_in_thread, project_path, title, body_available
       FROM threads
       WHERE last_ts >= ? AND ${repoFilter}
       ORDER BY last_ts DESC
       LIMIT ?`,
    )
    .all(...params) as ThreadRow[];
};

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

export interface SummaryRootHit {
  root: string;
  snippet: string;
}

// The curated-summary FTS search, ranked by bm25, for an already-tokenized MATCH
// query. The single owner of the summaries_fts query shape so `relevant`'s summary
// tier and `digest search` cannot drift on the query, the join, or the snippet
// markup. `snippetTokens` is a parameter because the two callers surface different
// amounts of context (relevant is compact, digest search is roomier). Throws on a
// malformed MATCH so each caller keeps its own fallback (relevant falls through to
// raw transcripts; digest search returns empty).
export const searchSummaryRoots = (
  db: Database,
  match: string,
  limit: number,
  snippetTokens: number,
): SummaryRootHit[] =>
  db
    .query(
      `SELECT s.root_session_id AS root,
              snippet(summaries_fts, 0, '[', ']', ' … ', ?) AS snippet
       FROM summaries_fts
       JOIN summaries s ON s.rowid = summaries_fts.rowid
       WHERE summaries_fts MATCH ?
       ORDER BY bm25(summaries_fts)
       LIMIT ?`,
    )
    .all(snippetTokens, match, limit) as SummaryRootHit[];

export interface ThreadMeta {
  title: string | null;
  last_ts: string | null;
  project_path: string | null;
}

// Display metadata for a thread root, keyed by the root session id. Shared by the
// summary-relevance and summary-search call sites so the hydrate query lives once.
export const threadMeta = (db: Database, root: string): ThreadMeta | null =>
  db
    .query("SELECT title, last_ts, project_path FROM sessions WHERE session_id = ?")
    .get(root) as ThreadMeta | null;

export interface RelevantThread {
  id: string;
  last_ts: string | null;
  project_path: string | null;
  title: string | null;
  snippet: string;
  opening: string | null;
  fromSummary: boolean;
}

// Threads most relevant to a prompt, summary-first. The curated summaries are dense
// and topical, so a match there is far higher-signal than raw-transcript bm25; we
// fill the result with summary matches first, then top up with raw-transcript
// matches for threads that have no summary yet (so the hook keeps working during
// backfill and for un-summarized recent sessions). bm25 scores are not comparable
// across the two FTS indexes, so we rank within each and prefer the summary tier
// wholesale rather than merging scores. Each thread is enriched with title +
// opening prompt so it is recognizable in injected context.
export const relevantThreads = (db: Database, prompt: string, limit = 3): RelevantThread[] => {
  const match = toMatchQuery(prompt);
  if (!match) return [];

  // Insertion order is the final order, and a root is only ever added once, so the
  // summary tier always outranks the raw tier for the same thread.
  const chosen = new Map<string, { snippet: string; fromSummary: boolean }>();

  // Tier 1: curated summaries, ranked by bm25.
  try {
    const summaryHits = searchSummaryRoots(db, match, limit, 10);
    for (const hit of summaryHits) {
      if (chosen.size >= limit) break;
      if (!chosen.has(hit.root)) chosen.set(hit.root, { snippet: hit.snippet, fromSummary: true });
    }
  } catch {
    // A malformed MATCH (rare, toMatchQuery quotes tokens) falls through to raw.
  }

  // Tier 2: raw transcripts, for threads not already covered by a summary match.
  if (chosen.size < limit) {
    interface Hit {
      root: string | null;
      snippet: string;
      score: number;
    }
    let hits: Hit[] = [];
    try {
      hits = db
        .query(
          `SELECT s.root_session_id AS root,
                  snippet(messages_fts, 0, '[', ']', ' … ', 10) AS snippet,
                  bm25(messages_fts) AS score
           FROM messages_fts
           JOIN messages m ON m.id = messages_fts.rowid
           JOIN sessions s ON s.session_id = m.session_id
           WHERE messages_fts MATCH ?
           ORDER BY bm25(messages_fts)
           LIMIT 80`,
        )
        .all(match) as Hit[];
    } catch {
      hits = [];
    }

    // Best (lowest bm25) raw hit per thread root, then fill remaining slots.
    const byRoot = new Map<string, Hit>();
    for (const hit of hits) {
      if (!hit.root) continue;
      const existing = byRoot.get(hit.root);
      if (!existing || hit.score < existing.score) byRoot.set(hit.root, hit);
    }
    for (const hit of [...byRoot.values()].sort((a, b) => a.score - b.score)) {
      if (chosen.size >= limit) break;
      if (!chosen.has(hit.root!)) {
        chosen.set(hit.root!, { snippet: hit.snippet, fromSummary: false });
      }
    }
  }

  return [...chosen.entries()].map(([root, info]) => {
    const meta = threadMeta(db, root);
    return {
      id: root,
      last_ts: meta?.last_ts ?? null,
      project_path: meta?.project_path ?? null,
      title: meta?.title ?? null,
      snippet: info.snippet,
      opening: threadOpeningPrompt(db, root),
      fromSummary: info.fromSummary,
    };
  });
};

// Resolve an exact id or a unique prefix to a full session id. Throws on an
// ambiguous prefix, returns null when nothing matches.
export const resolveSession = (db: Database, idOrPrefix: string): string | null => {
  const exact = db
    .query("SELECT session_id FROM sessions WHERE session_id = ?")
    .get(idOrPrefix) as { session_id: string } | null;
  if (exact) return exact.session_id;

  const matches = db
    .query("SELECT session_id FROM sessions WHERE session_id LIKE ? || '%' ESCAPE '\\' LIMIT 10")
    .all(escapeLike(idOrPrefix)) as { session_id: string }[];

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous session prefix "${idOrPrefix}" matches ${matches.length}: ` +
        matches.map((m) => m.session_id.slice(0, 12)).join(", "),
    );
  }
  return matches[0]!.session_id;
};

export interface Stats {
  threads: number;
  sessions: number;
  messages: number;
  deletedSources: number;
}

export const stats = (db: Database): Stats => {
  const one = (sql: string): number => (db.query(sql).get() as { c: number }).c;
  return {
    threads: countThreads(db),
    sessions: one("SELECT COUNT(*) AS c FROM sessions"),
    messages: one("SELECT COUNT(*) AS c FROM messages"),
    // "Deleted" means the source was on disk and is now gone. A NULL source_file is
    // a subagent-only parent stub whose top-level transcript was never seen; it is
    // body-unavailable but nothing was deleted, so it must not inflate this count.
    deletedSources: one(
      "SELECT COUNT(*) AS c FROM sessions WHERE body_available = 0 AND source_file IS NOT NULL",
    ),
  };
};
