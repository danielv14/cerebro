import type { Database } from "bun:sqlite";
import { searchSummaryRoots } from "./digest/index.ts";
import { dedupedHitWindow, type RankedMessageHit, rankedMessageHits, toMatchQuery } from "./fts.ts";
import { attachThreadDisplay, noThreadDisplay, threadOpeningPrompt } from "./thread.ts";

// Design notes: docs/architecture.md ("Relevance").

// bm25 is negative (lower = better); a decay factor in (0,1] shrinks an old hit's
// magnitude toward 0, ranking it worse.
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

export interface RepoScope {
  repoRoot?: string | null;
  cwd?: string | null;
}

// A boost, never a filter: a much stronger cross-repo match stays reachable.
const SAME_REPO_BOOST = 1.5;
const repoBoost = (
  hit: { git_root: string | null; project_path: string | null },
  scope: RepoScope,
): number => {
  if (scope.repoRoot) return hit.git_root === scope.repoRoot ? SAME_REPO_BOOST : 1;
  if (scope.cwd) return hit.project_path === scope.cwd ? SAME_REPO_BOOST : 1;
  return 1;
};

export const DEFAULT_RELEVANT_LIMIT = 3;

// The 80-row floor is the flat window the tier used to pin; per-root sizing is
// the fix for #141 (chatty threads owning the whole window).
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

export const relevantThreads = (
  db: Database,
  prompt: string,
  limit = DEFAULT_RELEVANT_LIMIT,
  now = Date.now(),
  scope: RepoScope = {},
): RelevantThread[] => {
  const match = toMatchQuery(prompt);
  if (!match) return [];

  // Insertion order is the final order and a root is only added once, so the
  // summary tier always outranks the raw tier for the same thread.
  const chosen = new Map<string, { snippet: string; fromSummary: boolean }>();

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
    // A malformed MATCH falls through to the raw tier.
  }

  if (chosen.size < limit) {
    const fetchWindow = (windowSize: number): RankedMessageHit[] => {
      try {
        return rankedMessageHits(db, match, { limit: windowSize, snippetTokens: 10 });
      } catch {
        return [];
      }
    };

    // Deduped on this tier's own rank (not bm25) so the kept hit is the one the
    // decay and boost actually rank on; target the full limit because these
    // roots may overlap the summary tier's. Growth stays off at the default
    // limit: this runs on a latency path.
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

  const hits = [...chosen.entries()].map(([root, info]) => ({ root, ...info }));
  return attachThreadDisplay(db, hits, noThreadDisplay).map(({ hit, display }) => ({
    id: hit.root,
    ...display,
    snippet: hit.snippet,
    opening: threadOpeningPrompt(db, hit.root),
    fromSummary: hit.fromSummary,
  }));
};
