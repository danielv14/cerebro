import type { Database } from "bun:sqlite";
import { escapeLike, threadOnBranch } from "./fts.ts";

const THREAD_MEMBERSHIP =
  "session_id IN (SELECT session_id FROM sessions WHERE root_session_id = ?)";

const THREAD_MESSAGE_ORDER = "ts, id";

// Callers that scope by project must filter the view's OUTPUT: filtering raw
// sessions before the GROUP BY drops resume/subagent rows with NULL project_path.
const rootPreferring = (column: string): string =>
  `COALESCE(
      MAX(CASE WHEN r.session_id = r.root_session_id THEN r.${column} END),
      MAX(r.${column})
    )`;

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

const latestThreads = (
  db: Database,
  conditions: string[],
  params: (string | number)[],
  limit: number,
): ThreadRow[] => {
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .query(`SELECT ${THREAD_ROW_COLUMNS} FROM threads ${where} ORDER BY last_ts DESC LIMIT ?`)
    .all(...params, limit) as ThreadRow[];
};

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
  return latestThreads(db, conditions, params, opts.limit ?? 30);
};

export const recentThreads = (
  db: Database,
  opts: { repoRoot?: string | null; cwd?: string; since: string; limit?: number },
): ThreadRow[] => {
  const repo = opts.repoRoot
    ? { sql: "git_root = ?", param: opts.repoRoot }
    : opts.cwd
      ? { sql: "project_path = ?", param: opts.cwd }
      : null;
  if (!repo) return [];
  return latestThreads(db, ["last_ts >= ?", repo.sql], [opts.since, repo.param], opts.limit ?? 5);
};

export interface ThreadIdentity {
  id: string;
  last_ts: string | null;
  project_path: string | null;
  provider: string | null;
  model: string | null;
  title: string | null;
}

export const threadIdentity = (
  id: string,
  row: Partial<Omit<ThreadIdentity, "id">> = {},
): ThreadIdentity => ({
  id,
  last_ts: row.last_ts ?? null,
  project_path: row.project_path ?? null,
  provider: row.provider ?? null,
  model: row.model ?? null,
  title: row.title ?? null,
});

const hydrateThreadIdentity = (db: Database, ids: string[]): Map<string, ThreadIdentity> => {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT id, title, last_ts, project_path, provider, model
       FROM threads WHERE id IN (${placeholders})`,
    )
    .all(...ids) as ThreadIdentity[];
  return new Map(rows.map((row) => [row.id, threadIdentity(row.id, row)]));
};

// A thread with no rollup row keeps its hit, with an identity that is nothing but
// the id: a summary has to outlive the sessions rows it was written from.
export const attachThreadIdentity = <H extends { id: string }>(
  db: Database,
  hits: H[],
): { hit: H; identity: ThreadIdentity }[] => {
  const byId = hydrateThreadIdentity(db, [...new Set(hits.map((hit) => hit.id))]);
  return hits.map((hit) => ({ hit, identity: byId.get(hit.id) ?? threadIdentity(hit.id) }));
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
       ORDER BY ${THREAD_MESSAGE_ORDER}`,
    )
    .all(root) as ThreadMessage[];
};

const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;

const typedWords = (text: string): string => {
  if (!text.startsWith("<command-")) return text;
  const args = COMMAND_ARGS.exec(text)?.[1]?.trim();
  if (args) return args;
  return COMMAND_NAME.exec(text)?.[1]?.trim() || text;
};

// Three tiers, worst last: a skill body and flattened tool output are injected and
// can never be the user's words, while a slash-command turn still carries them in
// its arguments.
export const threadOpeningPrompt = (db: Database, root: string): string | null => {
  const row = db
    .query(
      `SELECT text FROM messages
       WHERE ${THREAD_MEMBERSHIP}
         AND role = 'user' AND is_sidechain = 0
       ORDER BY (CASE
                   WHEN text LIKE '[%'
                     OR text LIKE 'Base directory for this skill:%' THEN 2
                   WHEN text LIKE '<command-%' THEN 1
                   ELSE 0 END), ts, id
       LIMIT 1`,
    )
    .get(root) as { text: string | null } | null;
  return row?.text == null ? null : typedWords(row.text);
};

export const messageOrdinal = (db: Database, root: string, id: number): number => {
  const row = db
    .query(
      `SELECT rn FROM (
         SELECT id, ROW_NUMBER() OVER (ORDER BY ${THREAD_MESSAGE_ORDER}) AS rn
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
  // First by id, not ts: insertion order equals conversational order, and a
  // tolerated NULL ts would shadow ts ordering. Sidechain rows are excluded
  // because the resume link lives on the first main-chain turn.
  const links = db
    .query(
      `SELECT f.session_id AS session, m.session_id AS parent
       FROM (
         SELECT MIN(id) AS first_id FROM messages
         WHERE is_sidechain = 0
         GROUP BY session_id
       ) firsts
       JOIN messages f ON f.id = firsts.first_id
       JOIN messages m ON m.uuid = f.parent_uuid
       WHERE m.session_id <> f.session_id`,
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

  const current = db
    .query("SELECT session_id, parent_session_id, root_session_id FROM sessions")
    .all() as {
    session_id: string;
    parent_session_id: string | null;
    root_session_id: string | null;
  }[];

  const update = db.query(
    `UPDATE sessions SET parent_session_id = ?, root_session_id = ? WHERE session_id = ?`,
  );
  const tx = db.transaction(() => {
    for (const row of current) {
      const parent = parentSession.get(row.session_id) ?? null;
      const root = rootOfSession(row.session_id);
      if (row.parent_session_id === parent && row.root_session_id === root) continue;
      update.run(parent, root, row.session_id);
    }
  });
  tx();
};
