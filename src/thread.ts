import type { Database } from "bun:sqlite";
import { escapeLike } from "./fts.ts";

// Design notes: docs/architecture.md ("Threads").

// Fixed literal the codebase owns; the root id stays a bound `?` at the call site.
const THREAD_MEMBERSHIP =
  "session_id IN (SELECT session_id FROM sessions WHERE root_session_id = ?)";

// Callers that scope by project must filter the view's OUTPUT: filtering raw
// sessions before the GROUP BY drops resume/subagent rows with NULL project_path.
const rootPreferring = (column: string): string =>
  `COALESCE(
      MAX(CASE WHEN r.session_id = r.root_session_id THEN r.${column} END),
      MAX(r.${column})
    )`;

// Single source of both the CREATE VIEW and the shape check openDb runs.
const THREADS_VIEW_COLUMN_EXPRS: [name: string, expr: string][] = [
  ["id", "r.root_session_id"],
  ["last_ts", "MAX(r.last_ts)"],
  ["first_ts", "MIN(r.first_ts)"],
  ["msgs", "SUM(r.msg_count)"],
  ["sessions_in_thread", "COUNT(*)"],
  ["project_path", rootPreferring("project_path")],
  ["git_root", rootPreferring("git_root")],
  ["git_branch", rootPreferring("git_branch")],
  ["provider", rootPreferring("provider")],
  ["model", rootPreferring("model")],
  ["title", rootPreferring("title")],
  ["body_available", "MIN(r.body_available)"],
];

// Changing this view needs a SCHEMA_VERSION bump in db.ts: CREATE VIEW IF NOT
// EXISTS silently keeps an old view.
export const THREADS_VIEW_DDL = `
DROP VIEW IF EXISTS threads;
CREATE VIEW IF NOT EXISTS threads AS
  SELECT
    ${THREADS_VIEW_COLUMN_EXPRS.map(([name, expr]) => `${expr} AS ${name}`).join(",\n    ")}
  FROM sessions r
  GROUP BY r.root_session_id
  HAVING SUM(r.msg_count) > 0;
`;

const THREADS_VIEW_COLUMNS = THREADS_VIEW_COLUMN_EXPRS.map(([name]) => name).join(",");

export const threadsViewIsCurrent = (db: Database): boolean => {
  const columns = db.query("PRAGMA table_info(threads)").all() as { name: string }[];
  return columns.map((column) => column.name).join(",") === THREADS_VIEW_COLUMNS;
};

// git_root is in the view but deliberately not projected: recent filters on it,
// no listing shows it.
const THREAD_ROW_COLUMNS =
  "id, last_ts, first_ts, msgs, sessions_in_thread, project_path, git_branch, provider, model, " +
  "title, body_available";

export interface ThreadRow {
  id: string;
  last_ts: string | null;
  first_ts: string | null;
  msgs: number;
  sessions_in_thread: number;
  project_path: string | null;
  git_branch: string | null;
  provider: string | null;
  model: string | null;
  title: string | null;
  body_available: number;
}

// `rootExpr` is a codebase literal; the branch fragment stays a bound `?`,
// LIKE-escaped by the caller.
export const threadOnBranch = (rootExpr: string): string =>
  `${rootExpr} IN (SELECT root_session_id FROM sessions ` +
  `WHERE git_branch LIKE '%' || ? || '%' ESCAPE '\\')`;

export const listThreads = (
  db: Database,
  opts: { project?: string; branch?: string; since?: string; limit?: number } = {},
): ThreadRow[] => {
  const params: (string | number)[] = [];
  const conditions: string[] = [];
  if (opts.project) {
    conditions.push("project_path LIKE '%' || ? || '%' ESCAPE '\\'");
    params.push(escapeLike(opts.project));
  }
  if (opts.branch) {
    conditions.push(threadOnBranch("id"));
    params.push(escapeLike(opts.branch));
  }
  if (opts.since) {
    conditions.push("last_ts >= ?");
    params.push(opts.since);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(opts.limit ?? 30);

  return db
    .query(
      `SELECT ${THREAD_ROW_COLUMNS}
       FROM threads
       ${where}
       ORDER BY last_ts DESC
       LIMIT ?`,
    )
    .all(...params) as ThreadRow[];
};

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
      `SELECT ${THREAD_ROW_COLUMNS}
       FROM threads
       WHERE last_ts >= ? AND ${repoFilter}
       ORDER BY last_ts DESC
       LIMIT ?`,
    )
    .all(...params) as ThreadRow[];
};

// The field order below is the JSON key order of `relevant` and `digest search`,
// which spread this whole shape into their result rows.
export interface ThreadDisplay {
  last_ts: string | null;
  project_path: string | null;
  provider: string | null;
  model: string | null;
  title: string | null;
}

// A root with no rollup row is simply absent from the map; attachThreadDisplay
// applies the caller's fallback.
const hydrateThreadDisplay = (db: Database, roots: string[]): Map<string, ThreadDisplay> => {
  if (roots.length === 0) return new Map();
  const placeholders = roots.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT id, title, last_ts, project_path, provider, model
       FROM threads WHERE id IN (${placeholders})`,
    )
    .all(...roots) as (ThreadDisplay & { id: string })[];
  return new Map(
    rows.map((row) => [
      row.id,
      {
        last_ts: row.last_ts,
        project_path: row.project_path,
        provider: row.provider,
        model: row.model,
        title: row.title,
      },
    ]),
  );
};

export const noThreadDisplay = (): ThreadDisplay => ({
  last_ts: null,
  project_path: null,
  provider: null,
  model: null,
  title: null,
});

// `fallback` is a parameter because the two policies for a thread with no rollup
// row are both deliberate and used to be three copies that could drift: `search`
// answers from the matched session's own columns, the summary-backed callers from
// nothing.
export const attachThreadDisplay = <H extends { root: string }, R>(
  db: Database,
  hits: H[],
  opts: {
    fallback: (hit: H) => ThreadDisplay;
    build: (hit: H, display: ThreadDisplay) => R;
  },
): R[] => {
  const byRoot = hydrateThreadDisplay(db, [...new Set(hits.map((hit) => hit.root))]);
  return hits.map((hit) => opts.build(hit, byRoot.get(hit.root) ?? opts.fallback(hit)));
};

export const rootOf = (db: Database, sessionId: string): string => {
  const row = db
    .query("SELECT root_session_id FROM sessions WHERE session_id = ?")
    .get(sessionId) as { root_session_id: string | null } | null;
  return row?.root_session_id ?? sessionId;
};

export interface ThreadMessage {
  role: string;
  ts: string | null;
  text: string;
  session_id: string;
  is_sidechain: number;
}

export const threadMessages = (db: Database, sessionId: string): ThreadMessage[] => {
  const root = rootOf(db, sessionId);
  return db
    .query(
      `SELECT m.role, m.ts, m.text, m.session_id, m.is_sidechain
       FROM messages m
       WHERE m.${THREAD_MEMBERSHIP}
       ORDER BY m.ts, m.id`,
    )
    .all(root) as ThreadMessage[];
};

export const threadOpeningPrompt = (db: Database, root: string): string | null => {
  const row = db
    .query(
      `SELECT text FROM messages
       WHERE ${THREAD_MEMBERSHIP}
         AND role = 'user' AND is_sidechain = 0
       ORDER BY (CASE WHEN text LIKE '[%' OR text LIKE '<command-%' THEN 1 ELSE 0 END), ts, id
       LIMIT 1`,
    )
    .get(root) as { text: string | null } | null;
  return row?.text ?? null;
};

// Same ORDER BY as threadMessages, so search's #N and show's numbering agree.
export const messageOrdinal = (db: Database, root: string, id: number): number => {
  const row = db
    .query(
      `SELECT rn FROM (
         SELECT id, ROW_NUMBER() OVER (ORDER BY ts, id) AS rn
         FROM messages WHERE ${THREAD_MEMBERSHIP}
       ) WHERE id = ?`,
    )
    .get(root, id) as { rn: number } | null;
  return row?.rn ?? 0;
};

export const threadLastTs = (db: Database, root: string): string | null => {
  const row = db
    .query("SELECT MAX(last_ts) AS mx FROM sessions WHERE root_session_id = ?")
    .get(root) as { mx: string | null };
  return row.mx;
};

export const countThreads = (db: Database): number => {
  const row = db.query("SELECT COUNT(*) AS c FROM threads").get() as { c: number };
  return row.c;
};

export const relinkThreads = (db: Database): void => {
  // Ordered by id, not ts: insertion order equals conversational order, and a
  // tolerated NULL ts would shadow ts ordering. Sidechain rows are excluded
  // because the resume link lives on the first main-chain turn.
  const links = db
    .query(
      `SELECT f.session_id AS session, m.session_id AS parent
       FROM (
         SELECT session_id, parent_uuid,
                ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id) AS rn
         FROM messages
         WHERE is_sidechain = 0
       ) f
       JOIN messages m ON m.uuid = f.parent_uuid
       WHERE f.rn = 1 AND m.session_id <> f.session_id`,
    )
    .all() as { session: string; parent: string }[];

  const parentSession = new Map<string, string>(links.map((l) => [l.session, l.parent]));

  const rootOfSession = (session: string): string => {
    const seen = new Set<string>();
    let cur = session;
    while (true) {
      seen.add(cur);
      const parent = parentSession.get(cur);
      if (!parent || seen.has(parent)) break;
      cur = parent;
    }
    return cur;
  };

  const allSessions = (
    db.query("SELECT session_id FROM sessions").all() as { session_id: string }[]
  ).map((r) => r.session_id);

  const update = db.query(
    `UPDATE sessions SET parent_session_id = ?, root_session_id = ? WHERE session_id = ?`,
  );
  const tx = db.transaction(() => {
    for (const session of allSessions) {
      update.run(parentSession.get(session) ?? null, rootOfSession(session), session);
    }
  });
  tx();
};
