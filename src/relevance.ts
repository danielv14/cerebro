import type { Database } from "bun:sqlite";
import { searchSummaryRoots } from "./digest/index.ts";
import { bestHitPerRoot, type RankedMessageHit, rankedMessageHits, toMatchQuery } from "./fts.ts";
import { hydrateThreadMeta, threadOpeningPrompt } from "./thread.ts";

// Relevance ranking. `relevant` answers "what past work relates to this prompt",
// which is a ranking question (two FTS tiers, recency decay, a same-repo boost)
// rather than a lookup, so it lives here with the weights it depends on.
//
// The dependency direction is one-way and cycle-free: this module reads the digest
// layer's summary search, the FTS layer's tokenizer and hit primitive, and the
// thread module's metadata hydrator, and none of those knows about ranking.

// Recency weighting for `relevant`. bm25 is negative (lower = more relevant);
// multiplying by a decay factor in (0,1] shrinks an old hit's magnitude toward 0,
// ranking it worse, so an equal text match prefers the recent thread. Half-life 90
// days; a thread with no known activity timestamp is treated as a year old.
// `search` and `digest search` stay pure bm25 on purpose: an explicit search should
// be deterministic text relevance, the per-prompt injection should favor fresh work.
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

// The repo a prompt was typed in, for `relevant`'s same-repo boost. Matched on the
// thread's git_root when the cwd is inside a git repo, else on the exact
// project_path, the same pairing recentThreads scopes by, so a thread `recent`
// considers in-repo is the same one `relevant` boosts.
export interface RepoScope {
  repoRoot?: string | null;
  cwd?: string | null;
}

// A prompt typed in repo X is far likelier to relate to past work in repo X than to
// an equally worded thread in an unrelated project, and the UserPromptSubmit payload
// already carries the cwd. bm25 is negative and lower is better, so the boost
// multiplies the decayed magnitude *up*, the mirror of how decayedRank shrinks it.
// 1.5x is worth roughly two months of recency at the 90-day half-life
// (2 ** (-60/90) ~= 0.63 ~= 1/1.5): a same-repo thread beats a cross-repo one of
// equal text relevance unless that one is about two months fresher. It is a boost,
// never a filter, so a much stronger cross-repo match stays reachable, which matters
// for shared-infrastructure work.
const SAME_REPO_BOOST = 1.5;
const repoBoost = (
  hit: { git_root: string | null; project_path: string | null },
  scope: RepoScope,
): number => {
  if (scope.repoRoot) return hit.git_root === scope.repoRoot ? SAME_REPO_BOOST : 1;
  if (scope.cwd) return hit.project_path === scope.cwd ? SAME_REPO_BOOST : 1;
  return 1;
};

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
// wholesale rather than merging scores. Within each tier the bm25 score is
// recency-decayed (decayedRank): the injection hook asks "what recent work relates
// to this prompt", so a two-year-old thread must not outrank last week's on an
// equal text match, and boosted when the thread is in the repo the prompt was typed
// in (`scope`, see repoBoost). Each thread is enriched with title + opening prompt so
// it is recognizable in injected context. `now` is injectable for tests, and the boost
// is a pure function of the rows, so ranking stays deterministic. An empty `scope`
// (manual use, or a hook payload without a cwd) ranks globally, as before.
export const relevantThreads = (
  db: Database,
  prompt: string,
  limit = 3,
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
    // rankedMessageHits attaches the thread rollup (last_ts + repo) from the
    // `threads` view, not the matched message's own session row: a resume can
    // carry a NULL git_root, and the view is root-preferring, so the boost sees
    // the thread's repo.
    let hits: RankedMessageHit[] = [];
    try {
      hits = rankedMessageHits(db, match, { limit: 80, snippetTokens: 10 });
    } catch {
      hits = [];
    }

    // Best (lowest decayed rank) raw hit per thread root, then fill remaining slots.
    const ranked = hits.map((hit) => ({
      ...hit,
      rank: decayedRank(hit.score, hit.last_ts, now, repoBoost(hit, scope)),
    }));
    for (const hit of bestHitPerRoot(ranked, (h) => h.rank)) {
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
      title: meta?.title ?? null,
      snippet: info.snippet,
      opening: threadOpeningPrompt(db, root),
      fromSummary: info.fromSummary,
    };
  });
};
