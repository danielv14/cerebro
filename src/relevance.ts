import type { Database } from "bun:sqlite";
import { searchSummaryRoots } from "./digest/store.ts";
import { type RankedHit, type RankedMessageHit, rankedMessageHits, toMatchQuery } from "./fts.ts";
import { attachThreadIdentity, type ThreadIdentity, threadOpeningPrompt } from "./thread.ts";

const bestHitPerThread = <T extends { id: string }>(hits: T[], rank: (hit: T) => number): T[] => {
  const byThread = new Map<string, { hit: T; rank: number }>();
  hits.forEach((hit) => {
    const hitRank = rank(hit);
    const existing = byThread.get(hit.id);
    if (!existing || hitRank < existing.rank) byThread.set(hit.id, { hit, rank: hitRank });
  });
  return [...byThread.values()].sort((a, b) => a.rank - b.rank).map((entry) => entry.hit);
};

const WINDOW_GROWTH = 4;
const WINDOW_ROUNDS = 3;

export interface DedupedWindow<T> {
  fetch: (size: number) => T[];
  targetThreads: number;
  minRows: number;
  rowsPerThread: number;
  grow?: boolean;
  rank: (hit: T) => number;
}

export const dedupedHitWindow = <T extends { id: string }>({
  fetch,
  targetThreads,
  minRows,
  rowsPerThread,
  grow = true,
  rank,
}: DedupedWindow<T>): T[] => {
  const rounds = grow ? WINDOW_ROUNDS : 0;
  let size = Math.max(minRows, targetThreads * rowsPerThread);
  let rows = fetch(size);
  let kept = bestHitPerThread(rows, rank);
  for (
    let round = 0;
    round < rounds && kept.length < targetThreads && rows.length >= size;
    round++
  ) {
    size *= WINDOW_GROWTH;
    rows = fetch(size);
    kept = bestHitPerThread(rows, rank);
  }
  return kept;
};

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
  const choose = (hits: RankedHit[], fromSummary: boolean): void => {
    for (const hit of hits) {
      if (chosen.size >= limit) return;
      if (!chosen.has(hit.id)) chosen.set(hit.id, { snippet: hit.snippet, fromSummary });
    }
  };
  const rankOf = (hit: RankedHit): number =>
    decayedRank(hit.score, hit.last_ts, now, repoBoost(hit, scope));

  try {
    const summaryHits = searchSummaryRoots(db, match, Math.max(limit * 4, 12), 10);
    choose(
      summaryHits.sort((a, b) => rankOf(a) - rankOf(b)),
      true,
    );
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
      rank: rankOf,
    });
    choose(kept, false);
  }

  const hits = [...chosen.entries()].map(([id, info]) => ({ id, ...info }));
  return attachThreadIdentity(db, hits).map(({ hit, identity }) => ({
    ...identity,
    snippet: hit.snippet,
    opening: threadOpeningPrompt(db, hit.id),
    fromSummary: hit.fromSummary,
  }));
};
