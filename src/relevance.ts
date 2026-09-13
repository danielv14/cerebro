import type { Database } from "bun:sqlite";
import { searchSummaryRoots } from "./digest/store.ts";
import {
  dedupedHitWindow,
  type RankedHit,
  type RankedMessageHit,
  rankedMessageHits,
  toMatchQuery,
} from "./fts.ts";
import { attachThreadIdentity, type ThreadIdentity, threadOpeningPrompt } from "./thread.ts";

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
const repoBoost = (hit: RankedHit, scope: RepoScope): number => {
  if (scope.repoRoot) return hit.git_root === scope.repoRoot ? SAME_REPO_BOOST : 1;
  if (scope.cwd) return hit.project_path === scope.cwd ? SAME_REPO_BOOST : 1;
  return 1;
};

export const DEFAULT_RELEVANT_LIMIT = 3;

// Sized per thread, not flat: one chatty thread otherwise owns the whole window.
const RAW_WINDOW_MIN_ROWS = 80;
const RAW_WINDOW_ROWS_PER_ROOT = 20;

export interface RelevantThread extends ThreadIdentity {
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
      if (!chosen.has(hit.id)) chosen.set(hit.id, { snippet: hit.snippet, fromSummary: true });
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
      targetThreads: limit,
      minRows: RAW_WINDOW_MIN_ROWS,
      rowsPerThread: RAW_WINDOW_ROWS_PER_ROOT,
      grow: limit > DEFAULT_RELEVANT_LIMIT,
      rank: (hit) => decayedRank(hit.score, hit.last_ts, now, repoBoost(hit, scope)),
    });
    for (const hit of kept) {
      if (chosen.size >= limit) break;
      if (!chosen.has(hit.id)) {
        chosen.set(hit.id, { snippet: hit.snippet, fromSummary: false });
      }
    }
  }

  const hits = [...chosen.entries()].map(([id, info]) => ({ id, ...info }));
  return attachThreadIdentity(db, hits).map(({ hit, identity }) => ({
    ...identity,
    snippet: hit.snippet,
    opening: threadOpeningPrompt(db, hit.id),
    fromSummary: hit.fromSummary,
  }));
};
