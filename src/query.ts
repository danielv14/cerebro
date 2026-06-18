import type { Database } from "bun:sqlite";

export interface SearchHit {
  id: number;
  session_id: string;
  ts: string | null;
  role: string;
  project_path: string | null;
  title: string | null;
  snippet: string;
}

// FTS5 search ranked by bm25 (lower = more relevant). User queries are passed to
// MATCH verbatim so power users can use FTS operators; if that errors on stray
// syntax, fall back to a sanitized phrase query of the bare tokens.
export const search = (db: Database, query: string, limit = 20): SearchHit[] => {
  const sql = `
    SELECT m.id, m.session_id, m.ts, m.role, s.project_path, s.title,
           snippet(messages_fts, 0, '[', ']', ' … ', 12) AS snippet
    FROM messages_fts
    JOIN messages m  ON m.id = messages_fts.rowid
    JOIN sessions s  ON s.session_id = m.session_id
    WHERE messages_fts MATCH ?
    ORDER BY bm25(messages_fts)
    LIMIT ?`;
  const stmt = db.query(sql);
  try {
    return stmt.all(query, limit) as SearchHit[];
  } catch {
    const sanitized = query
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => `"${token.replace(/"/g, '""')}"`)
      .join(" ");
    if (!sanitized) return [];
    return stmt.all(sanitized, limit) as SearchHit[];
  }
};

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

// List logical threads (roots), most-recently-active first. Each row aggregates
// every session folded into the thread.
export const listThreads = (
  db: Database,
  opts: { project?: string; limit?: number } = {},
): ThreadRow[] => {
  const params: (string | number)[] = [];
  // Filter after grouping, on the thread's representative project_path. Filtering
  // raw rows before GROUP BY would drop resume/subagent rows whose project_path is
  // NULL or differs, undercounting the thread's msgs and sessions_in_thread.
  let having = "";
  if (opts.project) {
    having = "WHERE project_path LIKE '%' || ? || '%'";
    params.push(opts.project);
  }
  params.push(opts.limit ?? 30);

  return db
    .query(
      `SELECT * FROM (
         SELECT
           r.root_session_id AS id,
           MAX(r.last_ts)    AS last_ts,
           MIN(r.first_ts)   AS first_ts,
           SUM(r.msg_count)  AS msgs,
           COUNT(*)          AS sessions_in_thread,
           COALESCE(
             MAX(CASE WHEN r.session_id = r.root_session_id THEN r.project_path END),
             MAX(r.project_path)
           ) AS project_path,
           COALESCE(
             MAX(CASE WHEN r.session_id = r.root_session_id THEN r.title END),
             MAX(r.title)
           ) AS title,
           MIN(r.body_available) AS body_available
         FROM sessions r
         GROUP BY r.root_session_id
       )
       ${having}
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
       FROM (
         SELECT
           r.root_session_id AS id,
           MAX(r.last_ts)    AS last_ts,
           MIN(r.first_ts)   AS first_ts,
           SUM(r.msg_count)  AS msgs,
           COUNT(*)          AS sessions_in_thread,
           COALESCE(
             MAX(CASE WHEN r.session_id = r.root_session_id THEN r.project_path END),
             MAX(r.project_path)
           ) AS project_path,
           COALESCE(
             MAX(CASE WHEN r.session_id = r.root_session_id THEN r.git_root END),
             MAX(r.git_root)
           ) AS git_root,
           COALESCE(
             MAX(CASE WHEN r.session_id = r.root_session_id THEN r.title END),
             MAX(r.title)
           ) AS title,
           MIN(r.body_available) AS body_available
         FROM sessions r
         GROUP BY r.root_session_id
       )
       WHERE last_ts >= ? AND ${repoFilter}
       ORDER BY last_ts DESC
       LIMIT ?`,
    )
    .all(...params) as ThreadRow[];
};

// The opening human prompt of a thread (earliest non-sidechain user turn across
// the thread, preferring prose over a bracket-tagged tool echo). Used to make a
// surfaced thread recognizable without opening it.
export const openingPrompt = (db: Database, rootId: string): string | null => {
  const row = db
    .query(
      `SELECT text FROM messages
       WHERE session_id IN (SELECT session_id FROM sessions WHERE root_session_id = ?)
         AND role = 'user' AND is_sidechain = 0
       ORDER BY (CASE WHEN text LIKE '[%' OR text LIKE '<command-%' THEN 1 ELSE 0 END), ts, id
       LIMIT 1`,
    )
    .get(rootId) as { text: string | null } | null;
  return row?.text ?? null;
};

// Turn a natural-language prompt into an FTS5 OR-of-tokens query, ranked by bm25.
// Implicit-AND (the default) would require every word to co-occur and usually
// return nothing for a prose prompt. No stopword stripping: bm25 already ranks
// common words low, and shaving a few tokens is not worth a hand-kept wordlist.
const toMatchQuery = (text: string): string | null => {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const unique = [...new Set(tokens)].slice(0, 40);
  if (unique.length === 0) return null;
  return unique.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
};

export interface RelevantThread {
  id: string;
  last_ts: string | null;
  project_path: string | null;
  title: string | null;
  snippet: string;
  opening: string | null;
}

// Threads most relevant to a prompt: FTS-search the prompt as OR-of-tokens, keep
// the best-ranked hit per thread, return the top `limit` threads enriched with
// title + opening prompt so they are recognizable in injected context.
export const relevantThreads = (
  db: Database,
  prompt: string,
  limit = 3,
): RelevantThread[] => {
  const match = toMatchQuery(prompt);
  if (!match) return [];

  interface Hit {
    root: string | null;
    ts: string | null;
    project_path: string | null;
    snippet: string;
    score: number;
  }
  let hits: Hit[];
  try {
    hits = db
      .query(
        `SELECT s.root_session_id AS root, m.ts AS ts, s.project_path AS project_path,
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
    return [];
  }

  // Best (lowest bm25) hit per thread root.
  const byRoot = new Map<string, Hit>();
  for (const hit of hits) {
    if (!hit.root) continue;
    const existing = byRoot.get(hit.root);
    if (!existing || hit.score < existing.score) byRoot.set(hit.root, hit);
  }

  const top = [...byRoot.values()].sort((a, b) => a.score - b.score).slice(0, limit);

  return top.map((hit) => {
    const meta = db
      .query(`SELECT title, last_ts, project_path FROM sessions WHERE session_id = ?`)
      .get(hit.root!) as
      | { title: string | null; last_ts: string | null; project_path: string | null }
      | null;
    return {
      id: hit.root!,
      last_ts: meta?.last_ts ?? hit.ts,
      project_path: meta?.project_path ?? hit.project_path,
      title: meta?.title ?? null,
      snippet: hit.snippet,
      opening: openingPrompt(db, hit.root!),
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
    .query("SELECT session_id FROM sessions WHERE session_id LIKE ? || '%' LIMIT 10")
    .all(idOrPrefix) as { session_id: string }[];

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous session prefix "${idOrPrefix}" matches ${matches.length}: ` +
        matches.map((m) => m.session_id.slice(0, 12)).join(", "),
    );
  }
  return matches[0]!.session_id;
};

export interface ThreadMessage {
  role: string;
  ts: string | null;
  text: string;
  session_id: string;
  is_sidechain: number;
}

// Find the root of whatever session id is given, then return the whole thread's
// messages (root + every resume) ordered chronologically.
export const threadMessages = (db: Database, sessionId: string): ThreadMessage[] => {
  const row = db
    .query("SELECT root_session_id FROM sessions WHERE session_id = ?")
    .get(sessionId) as { root_session_id: string | null } | null;
  const root = row?.root_session_id ?? sessionId;

  return db
    .query(
      `SELECT m.role, m.ts, m.text, m.session_id, m.is_sidechain
       FROM messages m
       WHERE m.session_id IN (SELECT session_id FROM sessions WHERE root_session_id = ?)
       ORDER BY m.ts, m.id`,
    )
    .all(root) as ThreadMessage[];
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
    threads: one(
      "SELECT COUNT(*) AS c FROM sessions WHERE session_id = root_session_id OR root_session_id IS NULL",
    ),
    sessions: one("SELECT COUNT(*) AS c FROM sessions"),
    messages: one("SELECT COUNT(*) AS c FROM messages"),
    deletedSources: one("SELECT COUNT(*) AS c FROM sessions WHERE body_available = 0"),
  };
};
