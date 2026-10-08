import type { Database } from "bun:sqlite";
import {
  type HitFilters,
  quoteFtsToken,
  type RankedMessageHit,
  rankedMessageHits,
  rankedMessageHitsPerThread,
} from "./fts.ts";
import { attachThreadIdentity, messageOrdinal } from "./thread.ts";

export interface SearchHit {
  // The matched message's rowid, not a thread id; `show --range` uses `ordinal`.
  message_id: number;
  session_id: string;
  ts: string | null;
  role: string;
  project_path: string | null;
  git_branch: string | null;
  provider: string | null;
  model: string | null;
  title: string | null;
  snippet: string;
  ordinal: number;
}

export interface SearchOpts extends HitFilters {
  all?: boolean;
}

export const SEARCH_ROLES = ["user", "assistant"] as const;

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
    const window = { limit, snippetTokens: 12, filters };
    return all
      ? rankedMessageHits(db, match, window)
      : rankedMessageHitsPerThread(db, match, window);
  };

  let kept: RankedMessageHit[];
  try {
    kept = collect(query);
  } catch {
    const sanitized = query.split(/\s+/).filter(Boolean).map(quoteFtsToken).join(" ");
    if (!sanitized) return [];
    kept = collect(sanitized);
  }

  // A search hit is a message, so it shows the message's own ts and branch and
  // leaves the thread's last_ts out.
  return attachThreadIdentity(db, kept).map(({ hit, identity }) => ({
    message_id: hit.message_id,
    session_id: hit.session_id,
    ts: hit.ts,
    role: hit.role,
    project_path: identity.project_path,
    git_branch: hit.session_git_branch,
    provider: identity.provider,
    model: identity.model,
    title: identity.title,
    snippet: hit.snippet,
    ordinal: messageOrdinal(db, hit.id, hit.message_id),
  }));
};
