import type { Database } from "bun:sqlite";
import { escapeLike } from "./fts.ts";

// Thread identity, membership, the `threads` rollup view and its readers.
// Design notes: docs/architecture.md ("Threads").

// A fixed literal the codebase owns (never user input), safe to interpolate; the
// root id stays a bound `?` parameter at the call site.
const THREAD_MEMBERSHIP =
  "session_id IN (SELECT session_id FROM sessions WHERE root_session_id = ?)";

// Root-preferring rollup: the root session's value, falling back to MAX over the
// resumes only when the root's is NULL. Callers that scope by project must filter
// the view's output AFTER the rollup; filtering raw sessions before the GROUP BY
// drops resume/subagent rows whose project_path is NULL or differs.
const rootPreferring = (column: string): string =>
  `COALESCE(
      MAX(CASE WHEN r.session_id = r.root_session_id THEN r.${column} END),
      MAX(r.${column})
    )`;

// Single source of both the CREATE VIEW and the shape check openDb compares
// against, so the two cannot drift.
//
// body_available is MIN so a thread is only body-available if every folded session
// still has its source on disk.
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

// HAVING SUM(msg_count) > 0 hides zero-message sessions (sidecar rows) from every
// reader at once (#83); the rows themselves are kept, so `show` still resolves.
// Changing this definition needs a SCHEMA_VERSION bump in db.ts: on an existing
// database CREATE VIEW IF NOT EXISTS silently keeps the old view.
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

// Compared on every open: a binary built for a different SCHEMA_VERSION can leave a
// current-looking version stamp over the other build's view, and version-gating
// alone would trust that forever (see openDb).
export const threadsViewIsCurrent = (db: Database): boolean => {
  const columns = db.query("PRAGMA table_info(threads)").all() as { name: string }[];
  return columns.map((column) => column.name).join(",") === THREADS_VIEW_COLUMNS;
};

// One projection for both thread listings. git_root is in the view but deliberately
// not projected: recent filters on it, no listing shows it.
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
  // Root-preferring, display-grade: a thread that spans branches shows its root's.
  git_branch: string | null;
  provider: string | null;
  model: string | null;
  title: string | null;
  body_available: number;
}

// Any-session, not root-preferring: branch work often starts in a resume of a
// thread whose root sat on master. `rootExpr` is a fixed literal the codebase owns;
// the branch fragment stays a bound `?`, LIKE-escaped by the caller.
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

// Matches on the thread's git_root when the cwd is in a git repo, else on the exact
// project_path.
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

export interface ThreadMeta {
  title: string | null;
  last_ts: string | null;
  project_path: string | null;
  provider: string | null;
  model: string | null;
}

// Display metadata for a set of thread roots, from the rollup rather than the
// root's own sessions row (#118). A root with no rollup row is simply absent from
// the map: callers fall back to null metadata rather than dropping the hit.
export const hydrateThreadMeta = (db: Database, roots: string[]): Map<string, ThreadMeta> => {
  if (roots.length === 0) return new Map();
  const placeholders = roots.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT id, title, last_ts, project_path, provider, model
       FROM threads WHERE id IN (${placeholders})`,
    )
    .all(...roots) as (ThreadMeta & { id: string })[];
  return new Map(rows.map(({ id, ...meta }) => [id, meta]));
};

// Falls back to the given id when the session row is absent or root_session_id is
// NULL (a not-yet-relinked session).
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

// Earliest non-sidechain user turn, preferring prose over a bracket-tagged or
// `<command-` tool echo.
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

// ROW_NUMBER over the exact ORDER BY (ts, id) that threadMessages sorts with, so
// search's #N ordinals and show's numbering share one definition. The 0 fallback is
// defensive only: search's FTS join guarantees the id is in the thread.
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

// Counts rows of the `threads` view, so the count derives from the same thread
// definition the listings use.
export const countThreads = (db: Database): number => {
  const row = db.query("SELECT COUNT(*) AS c FROM threads").get() as { c: number };
  return row.c;
};

// The sole writer of root_session_id. Linear in archive size, which is why
// runIndex only calls it when a file was read; the repair path for a crashed run
// is `cerebro index --full`, which always relinks.
export const relinkThreads = (db: Database): void => {
  // Pass 1: each session's earliest main-chain message with its parentUuid, joined
  // to the session owning that uuid. Sidechain rows are excluded: the resume link
  // lives on the first main-chain turn. Ordered by id, not ts: insertion order
  // equals conversational order on every path, and a tolerated NULL ts would
  // shadow ts-based ordering. The <> guard drops in-session parents.
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

  // Pass 2: walk to the root, guarding against cycles.
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
