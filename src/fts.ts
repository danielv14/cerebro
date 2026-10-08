import type { Database } from "bun:sqlite";
import { eng, removeStopwords, swe } from "stopword";
import { isToolText } from "./sources/claude-code-jsonl.ts";
import { type ThreadScope, threadScope } from "./thread.ts";

// A quoted FTS5 string is always valid syntax, whatever the token holds.
export const quoteFtsToken = (token: string): string => `"${token.replace(/"/g, '""')}"`;

// OR-of-tokens rather than FTS5's implicit AND, which returns nothing for prose.
export const toMatchQuery = (text: string): string | null => {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const meaningful = removeStopwords(tokens, [...swe, ...eng]);
  const unique = [...new Set(meaningful)].slice(0, 40);
  if (unique.length === 0) return null;
  return unique.map(quoteFtsToken).join(" OR ");
};

export interface RankedHit {
  // The thread, never the row the hit came from.
  id: string;
  snippet: string;
  // bm25; lower = more relevant.
  score: number;
  last_ts: string | null;
  git_root: string | null;
  project_path: string | null;
}

export interface RankedMessageHit extends RankedHit {
  message_id: number;
  session_id: string;
  ts: string | null;
  role: string;
  session_git_branch: string | null;
}

export interface HitFilters extends ThreadScope {
  since?: string;
  role?: string;
  prose?: boolean;
}

const hitPredicates = (filters: HitFilters): { where: string; params: (string | number)[] } => {
  const out: { sql: string; params: (string | number)[] }[] = threadScope(filters, {
    root: "s.root_session_id",
    projectPath: "t.project_path",
  });
  if (filters.since) out.push({ sql: "m.ts >= ?", params: [filters.since] });
  if (filters.role) out.push({ sql: "m.role = ?", params: [filters.role] });
  if (filters.prose) {
    // A message that opens with prose and then calls a tool further down is kept
    // on purpose.
    out.push({ sql: `NOT ${isToolText("m.text")}`, params: [] });
  }
  return {
    where: out.map((filter) => `AND ${filter.sql}`).join(" "),
    params: out.flatMap((filter) => filter.params),
  };
};

export interface RankedHitWindow {
  limit: number;
  snippetTokens: number;
  filters?: HitFilters;
}

const messageHitJoins = `
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.rowid
    JOIN sessions s ON s.session_id = m.session_id
    LEFT JOIN threads t ON t.id = s.root_session_id`;

const messageHitColumns = `
    m.id AS message_id, m.session_id, m.ts, m.role,
    s.root_session_id AS id,
    s.git_branch AS session_git_branch,
    snippet(messages_fts, 0, '[', ']', ' … ', ?) AS snippet,
    bm25(messages_fts) AS score,
    t.last_ts, t.git_root, t.project_path`;

// Throws on a malformed MATCH so each caller keeps its own fallback.
export const rankedMessageHits = (
  db: Database,
  match: string,
  window: RankedHitWindow,
): RankedMessageHit[] => {
  const filters = hitPredicates(window.filters ?? {});
  const sql = `
    SELECT ${messageHitColumns}
    ${messageHitJoins}
    WHERE messages_fts MATCH ?
    ${filters.where}
    ORDER BY bm25(messages_fts)
    LIMIT ?`;
  return db
    .query(sql)
    .all(window.snippetTokens, match, ...filters.params, window.limit) as RankedMessageHit[];
};

// bm25() cannot be called inside a window function, so the CTE materializes it
// first. Snippets are computed for the kept rows only, in a second query.
// Throws on a malformed MATCH, like rankedMessageHits.
export const rankedMessageHitsPerThread = (
  db: Database,
  match: string,
  window: RankedHitWindow,
): RankedMessageHit[] => {
  const filters = hitPredicates(window.filters ?? {});
  const best = db
    .query(`
    WITH matched AS MATERIALIZED (
      SELECT m.id AS message_id, s.root_session_id AS id, bm25(messages_fts) AS score
      ${messageHitJoins}
      WHERE messages_fts MATCH ?
      ${filters.where}
    ),
    ranked AS (
      SELECT message_id, score,
             ROW_NUMBER() OVER (PARTITION BY id ORDER BY score, message_id) AS rn
      FROM matched
    )
    SELECT message_id FROM ranked
    WHERE rn = 1
    ORDER BY score, message_id
    LIMIT ?`)
    .all(match, ...filters.params, window.limit) as {
    message_id: number;
  }[];
  if (best.length === 0) return [];

  const ids = best.map((row) => row.message_id);
  const hits = db
    .query(`
    SELECT ${messageHitColumns}
    ${messageHitJoins}
    WHERE messages_fts MATCH ?
    AND messages_fts.rowid IN (${ids.map(() => "?").join(", ")})`)
    .all(window.snippetTokens, match, ...ids) as RankedMessageHit[];
  const byId = new Map(hits.map((hit) => [hit.message_id, hit]));
  // An index --rebuild between the two queries can change a kept row so it no
  // longer matches.
  return ids.flatMap((id) => byId.get(id) ?? []);
};
