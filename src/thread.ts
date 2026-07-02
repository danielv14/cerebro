import type { Database } from "bun:sqlite";

// The thread module owns thread identity and membership: "what is one thread" lives
// here once, instead of the same SQL pattern restated across the query and digest
// layers. A thread is a root session plus its resumes and folded subagent
// (sidechain) transcripts, all sharing one root_session_id. This module is a pure
// reader: relinkThreads (in the indexer) stays the sole writer of root_session_id,
// and the `threads` view stays the single owner of thread rollup/aggregation.

// The thread-membership rule, expressed exactly once: the sessions that belong to a
// thread root are the rows whose root_session_id matches it. Every reader that scopes
// to a thread's sessions composes this fragment instead of restating the predicate,
// so the membership rule cannot drift between queries. It is a fixed literal the
// codebase owns (never user input), safe to interpolate; the root id stays a bound
// `?` parameter at the call site.
const THREAD_MEMBERSHIP =
  "session_id IN (SELECT session_id FROM sessions WHERE root_session_id = ?)";

// Resolve any session id (a root, a resume, or a subagent's parent) to its thread
// root. Falls back to the given id when the session row is absent or
// root_session_id is NULL (a not-yet-relinked session), preserving the historical
// `?? sessionId` behavior. The single home of root resolution.
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

// The 1-based position of a message within its thread's chronological order: the
// COUNT form of threadMessages' ORDER BY (ts, id) under SQLite's NULLs-first ASC
// semantics (a NULL ts sorts before every non-NULL ts). Owned here, next to
// threadMessages, so search's #N ordinals and show's outline/--range numbering
// share one definition and cannot drift.
export const messageOrdinal = (
  db: Database,
  root: string,
  ts: string | null,
  id: number,
): number => {
  const row = db
    .query(
      `SELECT COUNT(*) AS c FROM messages m2
       WHERE m2.${THREAD_MEMBERSHIP}
         AND (
           (m2.ts IS NULL AND ? IS NOT NULL)
           OR (m2.ts IS NULL AND ? IS NULL AND m2.id <= ?)
           OR (m2.ts IS NOT NULL AND ? IS NOT NULL
               AND (m2.ts < ? OR (m2.ts = ? AND m2.id <= ?)))
         )`,
    )
    .get(root, ts, ts, id, ts, ts, ts, id) as { c: number };
  return row.c;
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
