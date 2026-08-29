import type { Database } from "bun:sqlite";
import { searchSummaryRoots } from "./digest/index.ts";
import { dedupedHitWindow, type RankedMessageHit, rankedMessageHits, toMatchQuery } from "./fts.ts";
import { hydrateThreadMeta, threadOpeningPrompt } from "./thread.ts";

// Relevance ranking for `relevant`: two FTS tiers, recency decay, a same-repo
// boost. Design notes: docs/architecture.md ("Relevance").

// bm25 is negative (lower = more relevant); a decay factor in (0,1] shrinks an old
// hit's magnitude toward 0, ranking it worse. `search` and `digest search` stay
// pure bm25 on purpose: an explicit search should be deterministic text relevance.
const RELEVANCE_HALF_LIFE_DAYS = 90;
const UNKNOWN_AGE_DAYS = 365;
export const decayedRank = (
  bm25: number,
  lastTs: string | null,
  nowMs: number,
  boost = 1,
): number => {
  const parsed = lastTs ? Date.parse(lastTs) : Number.NaN;
  const ageDays = Number.isFinite(parsed)
    ? Math.max(0, (nowMs - parsed) / 86_400_000)
    : UNKNOWN_AGE_DAYS;
  return bm25 * 2 ** (-ageDays / RELEVANCE_HALF_LIFE_DAYS) * boost;
};

// Matched on the thread's git_root when the cwd is inside a git repo, else on the
// exact project_path: the same pairing recentThreads scopes by.
export interface RepoScope {
  repoRoot?: string | null;
  cwd?: string | null;
}

// 1.5x is worth roughly two months of recency at the 90-day half-life. A boost,
// never a filter, so a much stronger cross-repo match stays reachable.
const SAME_REPO_BOOST = 1.5;
const repoBoost = (
  hit: { git_root: string | null; project_path: string | null },
  scope: RepoScope,
): number => {
  if (scope.repoRoot) return hit.git_root === scope.repoRoot ? SAME_REPO_BOOST : 1;
  if (scope.cwd) return hit.project_path === scope.cwd ? SAME_REPO_BOOST : 1;
  return 1;
};

// At this limit the raw tier answers out of a single window (growth off below), so
// a hook invocation costs one query.
export const DEFAULT_RELEVANT_LIMIT = 3;

// Floored at the 80 rows the tier used to pin flat regardless of the limit; that
// flat window was the bug in #141, where eight chatty threads owned all 80 rows and
// `--limit 20` answered with 8.
const RAW_WINDOW_MIN_ROWS = 80;
const RAW_WINDOW_ROWS_PER_ROOT = 20;

export interface RelevantThread {
  id: string;
  last_ts: string | null;
  project_path: string | null;
  provider: string | null;
  model: string | null;
  title: string | null;
  snippet: string;
  opening: string | null;
  fromSummary: boolean;
}

// Summary tier first (dense, topical, higher-signal), raw transcripts top up.
// bm25 scores are not comparable across the two FTS indexes, so rank within each
// tier and prefer the summary tier wholesale rather than merging scores.
export const relevantThreads = (
  db: Database,
  prompt: string,
  limit = DEFAULT_RELEVANT_LIMIT,
  now = Date.now(),
  scope: RepoScope = {},
): RelevantThread[] => {
  const match = toMatchQuery(prompt);
  if (!match) return [];

  // Insertion order is the final order, and a root is only ever added once, so the
  // summary tier always outranks the raw tier for the same thread.
  const chosen = new Map<string, { snippet: string; fromSummary: boolean }>();

  // Tier 1: curated summaries. Over-fetch by bm25, then re-rank with recency decay.
  try {
    const summaryHits = searchSummaryRoots(db, match, Math.max(limit * 4, 12), 10)
      .map((hit) => ({
        ...hit,
        rank: decayedRank(hit.score, hit.last_ts, now, repoBoost(hit, scope)),
      }))
      .sort((a, b) => a.rank - b.rank);
    for (const hit of summaryHits) {
      if (chosen.size >= limit) break;
      if (!chosen.has(hit.root)) chosen.set(hit.root, { snippet: hit.snippet, fromSummary: true });
    }
  } catch {
    // A malformed MATCH (rare, toMatchQuery quotes tokens) falls through to raw.
  }

  // Tier 2: raw transcripts, for threads not already covered by a summary match.
  if (chosen.size < limit) {
    const fetchWindow = (windowSize: number): RankedMessageHit[] => {
      try {
        return rankedMessageHits(db, match, { limit: windowSize, snippetTokens: 10 });
      } catch {
        return [];
      }
    };

    // Deduped on this tier's own rank, not bm25, so the hit kept per thread is the
    // one the decay and the boost actually rank it on. The target is the full
    // `limit` (not the open slots) because this tier's roots may overlap the
    // summary tier's. Growth is off at the default limit: `relevant` sits on a
    // latency path, and the case where 80 rows hold too few threads is the one a
    // deeper fetch cannot fix.
    const kept = dedupedHitWindow({
      fetch: fetchWindow,
      targetRoots: limit,
      minRows: RAW_WINDOW_MIN_ROWS,
      rowsPerRoot: RAW_WINDOW_ROWS_PER_ROOT,
      grow: limit > DEFAULT_RELEVANT_LIMIT,
      rank: (hit) => decayedRank(hit.score, hit.last_ts, now, repoBoost(hit, scope)),
    });
    for (const hit of kept) {
      if (chosen.size >= limit) break;
      if (!chosen.has(hit.root)) {
        chosen.set(hit.root, { snippet: hit.snippet, fromSummary: false });
      }
    }
  }

  const metaByRoot = hydrateThreadMeta(db, [...chosen.keys()]);
  return [...chosen.entries()].map(([root, info]) => {
    const meta = metaByRoot.get(root);
    return {
      id: root,
      last_ts: meta?.last_ts ?? null,
      project_path: meta?.project_path ?? null,
      provider: meta?.provider ?? null,
      model: meta?.model ?? null,
      title: meta?.title ?? null,
      snippet: info.snippet,
      opening: threadOpeningPrompt(db, root),
      fromSummary: info.fromSummary,
    };
  });
};
