import type { Database } from "bun:sqlite";
import { escapeLike } from "./fts.ts";

// The thread module owns what a thread is, end to end: identity and membership,
// the `threads` rollup view (its DDL and the row shape the listings read), the
// thread listings, and relinkThreads, the sole writer of root_session_id. A
// logical thread is a root session plus its resumes and folded subagent
// (sidechain) transcripts, all sharing one root_session_id. The db module
// consumes the view DDL as an opaque fragment; adding a rollup column is a
// one-file change here (plus a SCHEMA_VERSION bump in db.ts).

// The thread-membership rule, expressed exactly once: the sessions that belong to a
// thread root are the rows whose root_session_id matches it. Every reader that scopes
// to a thread's sessions composes this fragment instead of restating the predicate,
// so the membership rule cannot drift between queries. It is a fixed literal the
// codebase owns (never user input), safe to interpolate; the root id stays a bound
// `?` parameter at the call site.
const THREAD_MEMBERSHIP =
  "session_id IN (SELECT session_id FROM sessions WHERE root_session_id = ?)";

// Root-preferring rollup: take the root session's value, and only fall back to MAX
// over the resumes when the root's is NULL. The aggregate must run over the
// unfiltered rows, so callers that scope by project filter the view's output AFTER
// the rollup; filtering raw sessions before the GROUP BY would drop resume/subagent
// rows whose project_path is NULL or differs, undercounting msgs and
// sessions_in_thread.
const rootPreferring = (column: string): string =>
  `COALESCE(
      MAX(CASE WHEN r.session_id = r.root_session_id THEN r.${column} END),
      MAX(r.${column})
    )`;

// The view's columns, each with the expression that fills it. The single source of
// both the CREATE VIEW below and the column list the shape check compares against,
// so the two cannot drift: a column added here reaches the DDL and the check in
// the same edit (drift is impossible, not merely detected).
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

// The single sessions -> threads rollup. Every caller that lists or scopes threads
// (listThreads, recentThreads, staleThreads) selects from this view rather than
// re-deriving the GROUP BY, so the rollup shape is defined exactly once.
//
// HAVING SUM(msg_count) > 0 is what makes "a thread" mean the same thing to every
// reader (#83). A session opened and closed right away still gets a sessions row
// (the sidecar metadata that outlives Claude Code's own cleanup) with msg_count 0;
// rolled up it was an empty thread showing as '0 msgs' / '(untitled)' in sessions,
// recent, and the stats thread count, while 'digest stale' already excluded it.
// Excluding it here rather than per listing keeps countThreads and topProjects from
// disagreeing with the listings. Nothing is deleted: the sessions rows stay, so
// 'show' on such a session still resolves and the deleted-source stats (which
// read sessions) are unaffected.
//
// Changing this definition needs a SCHEMA_VERSION bump in db.ts (on an existing
// database CREATE VIEW IF NOT EXISTS silently keeps the old view; the DROP below
// plus the bump is what replaces it).
export const THREADS_VIEW_DDL = `
DROP VIEW IF EXISTS threads;
CREATE VIEW IF NOT EXISTS threads AS
  SELECT
    ${THREADS_VIEW_COLUMN_EXPRS.map(([name, expr]) => `${expr} AS ${name}`).join(",\n    ")}
  FROM sessions r
  GROUP BY r.root_session_id
  HAVING SUM(r.msg_count) > 0;
`;

// The view's column list, in view order, derived from the same declaration the DDL
// is built from. openDb compares this against the live view on every open (one
// PRAGMA, and only when the version stamp already matches): a binary built for a
// different SCHEMA_VERSION racing this one through the first open after an upgrade
// can leave a current-looking stamp over the other build's view, and version-gating
// alone would then trust that forever while every reader of a missing column fails.
const THREADS_VIEW_COLUMNS = THREADS_VIEW_COLUMN_EXPRS.map(([name]) => name).join(",");

export const threadsViewIsCurrent = (db: Database): boolean => {
  const columns = db.query("PRAGMA table_info(threads)").all() as { name: string }[];
  return columns.map((column) => column.name).join(",") === THREADS_VIEW_COLUMNS;
};

// The `threads` view columns a thread listing reads, in view order. One projection
// for the thread listing and the repo-scoped recent listing, so a column added to a
// ThreadRow reaches both readers instead of one. git_root is in the view but
// deliberately not projected: recent filters on it, no listing shows it.
const THREAD_ROW_COLUMNS =
  "id, last_ts, first_ts, msgs, sessions_in_thread, project_path, git_branch, provider, model, " +
  "title, body_available";

// One row of the `threads` view as the listings read it; the projection that fills
// it is THREAD_ROW_COLUMNS above, shared by both readers.
export interface ThreadRow {
  id: string;
  last_ts: string | null;
  first_ts: string | null;
  msgs: number;
  sessions_in_thread: number;
  project_path: string | null;
  // The thread's representative branch (root-preferring, from the `threads` view).
  // Display-grade: a thread that spans branches shows its root's.
  git_branch: string | null;
  // Which source adapter the thread came from ("claude-code", ...) and the model
  // its root records. Root-preferring and display-grade like git_branch; carried
  // in the JSON listings, not rendered in the text rows.
  provider: string | null;
  model: string | null;
  title: string | null;
  body_available: number;
}

// The branch filter, expressed exactly once: a thread touches a branch when ANY of
// its sessions was recorded on it, not only its root, because branch work often
// starts in a resume of a thread whose root sat on master. `search --branch` and
// `sessions --branch` compose this instead of spelling out two subqueries that a
// comment claims are the same rule.
//
// `rootExpr` is how the caller's row names the thread root (`id` on the threads view,
// `s.root_session_id` on a joined sessions row): a fixed literal the codebase owns,
// safe to interpolate. The branch fragment stays a bound `?` and is LIKE-escaped by
// the caller, which is where the ESCAPE clause below expects it.
export const threadOnBranch = (rootExpr: string): string =>
  `${rootExpr} IN (SELECT root_session_id FROM sessions ` +
  `WHERE git_branch LIKE '%' || ? || '%' ESCAPE '\\')`;

// List logical threads (roots), most-recently-active first, from the `threads`
// view. The filters apply AFTER the rollup: the project on the thread's
// representative project_path, so a thread is matched on its root's project even
// when a resume's project_path is NULL or differs, and `since` on the thread's
// last activity, the same `last_ts >= ?` comparison recentThreads uses (lexical,
// because stored timestamps are ISO-8601). `branch` is any-session rather than
// root-preferring (the same semantics and reasoning as search's, see
// SearchOpts.branch): a thread matches when any of its sessions was recorded on
// the branch, even though the listing displays the root's.
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
  // Which source adapter the thread came from and the model its root records.
  // Root-preferring and display-grade, the same values ThreadRow carries, so every
  // JSON listing names a thread's provider identically.
  provider: string | null;
  model: string | null;
}

// Display metadata for a set of thread roots, keyed by root session id. Read from
// the `threads` rollup, not from the root's own sessions row (#118): for a thread
// with resumes the root's row carries the first session's last_ts and often no title
// at all, so reading it made `relevant` and `digest search` disagree with `sessions`
// and `recent` on the same thread. One query for N roots, so the summary-relevance
// and summary-search call sites stop hydrating per hit.
//
// A root with no rollup row is simply absent from the map. The view carries
// HAVING SUM(msg_count) > 0 and searchSummaryRoots LEFT JOINs it deliberately, so a
// summary whose sessions rows are gone must still render its hit; callers fall back
// to null metadata rather than dropping it.
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

// Resolve any session id (a root, a resume, or a subagent's parent) to its thread
// root. Falls back to the given id when the session row is absent or
// root_session_id is NULL (a not-yet-relinked session). The single home of root
// resolution.
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

// Find the root of whatever session id is given, then return the whole thread's
// messages (root + every resume, including folded subagent turns) ordered
// chronologically by timestamp then id. The thread membership is expressed once,
// as the in-database IN (subquery) over root_session_id.
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

// The opening human prompt of a thread (earliest non-sidechain user turn across the
// thread, preferring prose over a bracket-tagged or `<command-` tool echo). `root`
// is a thread root id. Used to make a surfaced thread recognizable without opening
// it.
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

// The 1-based position of a message within its thread's chronological order.
// ROW_NUMBER over the exact ORDER BY (ts, id) that threadMessages sorts with (ASC,
// so a NULL ts sorts first), making "ordinal = position in threadMessages' order"
// structurally true rather than re-derived. Owned here, next to threadMessages, so
// search's #N ordinals and show's outline/--range numbering share one definition
// and cannot drift. The id always comes from a message in the thread (search's FTS
// join guarantees it); the 0 fallback is defensive only.
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

// The thread's most recent activity: MAX(last_ts) across the root and all its
// resumes. Backs digest's writeSummary when it stamps source_last_ts, so later
// activity makes a summary stale.
export const threadLastTs = (db: Database, root: string): string | null => {
  const row = db
    .query("SELECT MAX(last_ts) AS mx FROM sessions WHERE root_session_id = ?")
    .get(root) as { mx: string | null };
  return row.mx;
};

// The number of logical threads in the archive. Counts rows of the canonical
// `threads` rollup view (one row per root_session_id), so the count derives from the
// same thread definition the listings use and can never diverge from what sessions,
// recent, and digest stale surface. The thread module owns this count; the stats
// reader calls here instead of re-deriving a root-vs-resume expression.
export const countThreads = (db: Database): number => {
  const row = db.query("SELECT COUNT(*) AS c FROM threads").get() as { c: number };
  return row.c;
};

// Build logical threads across resumes: the write half of thread identity, and the
// sole writer of root_session_id. A resume's first message has a parentUuid owned
// by an earlier session; chaining those parents up gives each thread's root. Cost
// is linear in archive size (a window scan over messages plus an UPDATE of every
// sessions row), which is why runIndex only calls it when a file was read. The
// accepted consequence: a run that crashed after ingest but before this call
// leaves stale links that a later no-op run no longer repairs. The repair path is
// `cerebro index --full`, which always reads files and so always relinks.
export const relinkThreads = (db: Database): void => {
  // Pass 1: direct parent session, in one query. The inner subquery finds the
  // earliest main-chain message per session, with its parentUuid. Sidechain rows
  // are excluded: the resume link lives on the first main-chain turn, and a folded
  // subagent turn can never carry it (a pure-subagent stub then has no candidate
  // row, which is correct: it has no parent link to find). Ordering is by id, not
  // ts: for a session's main-chain messages, insertion order equals file order
  // equals conversational order on every path (files scan oldest-first, appends get
  // higher ids, re-reads dedup onto the original rows), so the lowest id is the
  // true first turn regardless of missing or unordered timestamps (either ts-based
  // ordering can be shadowed by a tolerated NULL ts).
  //
  // The join resolves which session owns the referenced parentUuid (uuid is UNIQUE,
  // so at most one owner per first-message); a NULL parent_uuid simply never joins,
  // and the <> guard drops in-session parents, so only cross-session resume links
  // survive.
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
