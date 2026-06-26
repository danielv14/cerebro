import type { Database } from "bun:sqlite";
import fs from "node:fs";
import { DIGEST_PROMPT_SIGNATURE } from "./digest.ts";
import { gitInfo } from "./git.ts";
import { classify, parseLine } from "./jsonl.ts";
import { discoverSessionFiles, type SessionFile } from "./paths.ts";

interface FileMeta {
  sessionId: string;
  projectDir: string;
  sourceFile: string;
  cwd: string | null;
  gitBranch: string | null;
  title: string | null;
  titlePriority: number;
}

// Read raw bytes [start, size) synchronously. We work on bytes (not characters)
// because the per-file cursor is a byte offset; 0x0A (\n) never appears inside a
// UTF-8 multibyte sequence, so splitting the byte buffer on newline is safe.
const readRange = (path: string, start: number, size: number): Buffer => {
  const length = size - start;
  if (length <= 0) return Buffer.alloc(0);

  const fd = fs.openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    let offset = 0;
    let position = start;
    while (offset < length) {
      const read = fs.readSync(fd, buf, offset, length - offset, position);
      if (read === 0) break;
      offset += read;
      position += read;
    }
    return offset === length ? buf : buf.subarray(0, offset);
  } finally {
    fs.closeSync(fd);
  }
};

// Split a byte buffer read at `start` into complete JSONL lines plus the new
// cursor. The cursor only advances past a trailing '\n' (or a final line that
// parses cleanly without one), so a half-written last line is left for next time.
// Shared by the real indexer and the dry-run analyzer so both agree exactly on
// what counts as indexable.
export const splitBuffer = (buf: Buffer, start: number): { lines: string[]; cursor: number } => {
  if (buf.length === 0) return { lines: [], cursor: start };

  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline >= 0) {
    const lines = buf.subarray(0, lastNewline).toString("utf8").split("\n");
    let cursor = start + lastNewline + 1;
    const tail = buf
      .subarray(lastNewline + 1)
      .toString("utf8")
      .trim();
    if (tail && parseLine(tail) !== undefined) {
      lines.push(tail);
      cursor = start + buf.length;
    }
    return { lines, cursor };
  }

  const tail = buf.toString("utf8").trim();
  if (tail && parseLine(tail) !== undefined) return { lines: [tail], cursor: start + buf.length };

  // Mid-write, no complete line yet. Wait for the next run.
  return { lines: [], cursor: start };
};

// Insert any new messages from a file's freshly-split lines and harvest the
// metadata for its session row. The bytes were already read and split by
// eachIndexableFile; this is the write half, run inside the per-file transaction.
const ingestLines = (db: Database, file: SessionFile, lines: string[]): FileMeta => {
  const meta: FileMeta = {
    sessionId: file.sessionId,
    projectDir: file.projectDir,
    sourceFile: file.path,
    cwd: null,
    gitBranch: null,
    title: null,
    titlePriority: 0,
  };

  const insert = db.query(
    `INSERT OR IGNORE INTO messages (uuid, session_id, parent_uuid, line_no, ts, role, text, is_sidechain)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const line of lines) {
    if (!line) continue;
    const parsed = parseLine(line);
    if (parsed === undefined) continue;
    const classified = classify(parsed);

    if (classified.kind === "message") {
      // Attribute every message to the file's owning session id. For a top-level
      // file that is its own UUID; for a subagent file it is the parent session,
      // so the sidechain folds into the parent thread. Resumes write fresh files
      // with new UUIDs; cross-file threading is rebuilt later by relinkThreads.
      insert.run(
        classified.uuid,
        meta.sessionId,
        classified.parentUuid,
        null,
        classified.ts,
        classified.role,
        classified.text,
        classified.isSidechain ? 1 : 0,
      );
      if (!meta.cwd && classified.cwd) meta.cwd = classified.cwd;
      if (!meta.gitBranch && classified.gitBranch) meta.gitBranch = classified.gitBranch;
    } else if (classified.kind === "title") {
      if (classified.priority > meta.titlePriority) {
        meta.title = classified.title;
        meta.titlePriority = classified.priority;
      }
    }
  }

  return meta;
};

interface SessionAggregate {
  c: number;
  mn: string | null;
  mx: string | null;
}

// Message count and timestamp span for a session, recomputed from the messages
// table. Shared by the two session-row maintainers so the aggregate is defined
// once.
const sessionAggregate = (db: Database, sessionId: string): SessionAggregate =>
  db
    .query(
      `SELECT COUNT(*) AS c, MIN(ts) AS mn, MAX(ts) AS mx
       FROM messages WHERE session_id = ?`,
    )
    .get(sessionId) as SessionAggregate;

// Both session-row writers share one INSERT shape and one set of refreshed
// aggregates; they differ only in which operand wins the per-column COALESCE on
// conflict. The aggregate columns (first_ts, last_ts, msg_count) always refresh from
// the just-recomputed counts, and root_session_id is left untouched on conflict
// (relinkThreads owns it) while defaulting to the session itself on insert, so a row
// is never NULL-rooted even before relinkThreads runs. body_available is NOT NULL, so
// whichever side the COALESCE prefers always supplies a value.

// Write the session row for a top-level file. The top-level file is the authority for
// its session, so its fresh values win the merge: COALESCE prefers excluded (the new
// row) and falls back to the existing row only where the new value is NULL.
const upsertSession = (db: Database, meta: FileMeta): void => {
  const existing = db
    .query(`SELECT cwd FROM sessions WHERE session_id = ?`)
    .get(meta.sessionId) as { cwd: string | null } | null;

  const cwd = meta.cwd ?? existing?.cwd ?? null;
  const git = gitInfo(cwd);
  const agg = sessionAggregate(db, meta.sessionId);

  db.query(
    `INSERT INTO sessions (
       session_id, root_session_id, project_dir, project_path, cwd, git_root,
       git_remote, git_branch, source_file, title, first_ts, last_ts, msg_count,
       body_available
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       project_dir    = COALESCE(excluded.project_dir, sessions.project_dir),
       project_path   = COALESCE(excluded.project_path, sessions.project_path),
       cwd            = COALESCE(excluded.cwd, sessions.cwd),
       git_root       = COALESCE(excluded.git_root, sessions.git_root),
       git_remote     = COALESCE(excluded.git_remote, sessions.git_remote),
       git_branch     = COALESCE(excluded.git_branch, sessions.git_branch),
       source_file    = COALESCE(excluded.source_file, sessions.source_file),
       title          = COALESCE(excluded.title, sessions.title),
       body_available = COALESCE(excluded.body_available, sessions.body_available),
       first_ts       = excluded.first_ts,
       last_ts        = excluded.last_ts,
       msg_count      = excluded.msg_count`,
  ).run(
    meta.sessionId,
    meta.sessionId,
    meta.projectDir,
    cwd,
    cwd,
    git.root,
    git.remote,
    meta.gitBranch,
    meta.sourceFile,
    meta.title,
    agg.mn,
    agg.mx,
    agg.c,
    1,
  );
};

// A subagent file's messages belong to the parent session. Ensure that parent row
// exists and refresh its aggregate, but never clobber the parent's identity fields,
// which are owned by its top-level file. Here the existing row wins the merge:
// COALESCE prefers sessions, so the values this passes (project_dir, project_path,
// cwd, git_branch) only fill a not-yet-seen parent and never overwrite the
// top-level's. The fields a subagent cannot know (git_root, git_remote, source_file,
// title) are passed NULL, so on a pure-subagent stub source_file stays NULL and the
// row reads as body-unavailable.
const touchParentSession = (db: Database, parentId: string, meta: FileMeta): void => {
  const agg = sessionAggregate(db, parentId);

  db.query(
    `INSERT INTO sessions (
       session_id, root_session_id, project_dir, project_path, cwd, git_root,
       git_remote, git_branch, source_file, title, first_ts, last_ts, msg_count,
       body_available
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       project_dir    = COALESCE(sessions.project_dir, excluded.project_dir),
       project_path   = COALESCE(sessions.project_path, excluded.project_path),
       cwd            = COALESCE(sessions.cwd, excluded.cwd),
       git_root       = COALESCE(sessions.git_root, excluded.git_root),
       git_remote     = COALESCE(sessions.git_remote, excluded.git_remote),
       git_branch     = COALESCE(sessions.git_branch, excluded.git_branch),
       source_file    = COALESCE(sessions.source_file, excluded.source_file),
       title          = COALESCE(sessions.title, excluded.title),
       body_available = COALESCE(sessions.body_available, excluded.body_available),
       first_ts       = excluded.first_ts,
       last_ts        = excluded.last_ts,
       msg_count      = excluded.msg_count`,
  ).run(
    parentId,
    parentId,
    meta.projectDir,
    meta.cwd,
    meta.cwd,
    null,
    null,
    meta.gitBranch,
    null,
    null,
    agg.mn,
    agg.mx,
    agg.c,
    1,
  );
};

// Mark sessions whose source file no longer exists on disk as body-unavailable,
// and (re)mark present ones as available. A temp table keeps this correct and
// cheap regardless of how many files there are.
const markDeletedBodies = (db: Database, files: SessionFile[]): void => {
  // An empty scan almost always means a transient readdir failure, not that every
  // session was deleted. Bail rather than flag the whole archive body-unavailable.
  if (files.length === 0) return;

  db.run("DROP TABLE IF EXISTS _present");
  db.run("CREATE TEMP TABLE _present (p TEXT PRIMARY KEY)");
  const insert = db.query("INSERT OR IGNORE INTO _present (p) VALUES (?)");
  const fill = db.transaction(() => {
    for (const file of files) insert.run(file.path);
  });
  fill();
  // A NULL source_file (a parent stub created only from subagent files, whose
  // top-level transcript is not on disk) is correctly treated as unavailable.
  db.run(
    `UPDATE sessions
       SET body_available = CASE WHEN source_file IN (SELECT p FROM _present) THEN 1 ELSE 0 END`,
  );
  db.run("DROP TABLE _present");
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

// Build logical threads across resumes. A resume's first message has a parentUuid
// owned by an earlier session; chaining those parents up gives each thread's root.
export const relinkThreads = (db: Database): void => {
  // Earliest message per session (ts then id), with its parentUuid.
  const firsts = db
    .query(
      `SELECT session_id, parent_uuid FROM (
         SELECT session_id, parent_uuid,
                ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts, id) AS rn
         FROM messages
       ) WHERE rn = 1`,
    )
    .all() as { session_id: string; parent_uuid: string | null }[];

  // Resolve which session owns each referenced parentUuid.
  const parentUuids = [...new Set(firsts.map((f) => f.parent_uuid).filter(Boolean) as string[])];
  const ownerOf = new Map<string, string>();
  for (const group of chunk(parentUuids, 500)) {
    const placeholders = group.map(() => "?").join(",");
    const rows = db
      .query(`SELECT uuid, session_id FROM messages WHERE uuid IN (${placeholders})`)
      .all(...group) as { uuid: string; session_id: string }[];
    for (const row of rows) ownerOf.set(row.uuid, row.session_id);
  }

  // Pass 1: direct parent session.
  const parentSession = new Map<string, string>();
  for (const first of firsts) {
    if (!first.parent_uuid) continue;
    const owner = ownerOf.get(first.parent_uuid);
    if (owner && owner !== first.session_id) parentSession.set(first.session_id, owner);
  }

  // Pass 2: walk to the root, guarding against cycles.
  const rootOf = (session: string): string => {
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
      update.run(parentSession.get(session) ?? null, rootOf(session), session);
    }
  });
  tx();
};

export interface IndexResult {
  newMessages: number;
  filesScanned: number;
  filesIndexed: number;
}

type FileStatus = "new" | "grown" | "truncated" | "unchanged";

interface FileReadPlan {
  start: number; // byte offset to read from
  status: FileStatus;
  shouldRead: boolean; // false only when unchanged (and not full)
}

// The single source of truth for the per-file cursor/skip/truncate decision in
// front of splitBuffer. runIndex and dryRunIndex both consume this so they cannot
// drift on what counts as indexable (invariant #2: dry-run must report exactly
// what a real run would process). `full` forces a re-read from byte 0 and never
// short-circuits as unchanged; in full mode the status is always "grown"/"new"
// and callers ignore it for categorization.
export const planFileRead = (
  state: { bytes_indexed: number; mtime_ms: number } | null,
  file: SessionFile,
  full: boolean,
): FileReadPlan => {
  if (full) {
    return { start: 0, status: state ? "grown" : "new", shouldRead: true };
  }

  const start = state ? state.bytes_indexed : 0;
  if (start > file.size) {
    // truncated / rotated -> re-read from the start
    return { start: 0, status: "truncated", shouldRead: true };
  }

  if (state && start === file.size && state.mtime_ms === file.mtimeMs) {
    return { start, status: "unchanged", shouldRead: false };
  }

  return { start, status: state ? "grown" : "new", shouldRead: true };
};

interface ScannedFile {
  file: SessionFile;
  plan: FileReadPlan;
  lines: string[];
  cursor: number;
}

// The single scan shared by runIndex and dryRunIndex: for each discovered file,
// look up its cursor state, decide via planFileRead whether to read, and for the
// ones to read, pull the new bytes and split them into complete lines. Hosting the
// discover-state-plan-read-split sequence here (not in two parallel loops) is what
// keeps invariant #2 structural: both consumers see exactly the same lines/cursor
// for a given file. What to do with the result (write vs count) and how to treat a
// mid-write file whose cursor did not advance is left to `handle`.
//
// `onUnchanged` is invoked for files planFileRead skips (so the dry run can count
// them). `onError` isolates a per-file read/handle failure (a vanished or corrupt
// file) so one bad file does not abort the whole run; without it the error
// propagates, which is what the dry run wants.
const eachIndexableFile = (
  db: Database,
  files: SessionFile[],
  full: boolean,
  handle: (scanned: ScannedFile) => void,
  opts: { onUnchanged?: () => void; onError?: (file: SessionFile, error: Error) => void } = {},
): void => {
  const getState = db.query(
    "SELECT bytes_indexed, mtime_ms FROM index_state WHERE source_file = ?",
  );

  for (const file of files) {
    const state = getState.get(file.path) as { bytes_indexed: number; mtime_ms: number } | null;

    const plan = planFileRead(state, file, full);
    if (!plan.shouldRead) {
      opts.onUnchanged?.();
      continue;
    }

    try {
      const buf = readRange(file.path, plan.start, file.size);
      const { lines, cursor } = splitBuffer(buf, plan.start);
      handle({ file, plan, lines, cursor });
    } catch (error) {
      if (!opts.onError) throw error;
      opts.onError(file, error as Error);
    }
  }
};

// True when these lines are cerebro's own headless summarization run rather than a
// real session. The SessionEnd hook pipes a transcript through
// `claude -p "$(cerebro digest prompt)"`, which Claude Code records as an ordinary
// session under ~/.claude/projects; its first turn is the digest prompt as a user
// message. Indexing it would feed the prompt's boilerplate back into the archive as
// searchable noise and mis-title the stub from the summary it produced, so the
// indexer skips it. New digest runs avoid writing a transcript at all (the hook
// passes --no-session-persistence); this guard covers transcripts already on disk
// and any that slip through. Caller gates on plan.start === 0 so it only inspects a
// file read whole from the start, never a mid-file incremental read whose first line
// is an arbitrary turn.
const isDigestRunTranscript = (lines: string[]): boolean => {
  for (const line of lines) {
    if (!line) continue;
    const parsed = parseLine(line);
    if (parsed === undefined) continue;
    const classified = classify(parsed);
    if (classified.kind !== "message") continue;
    // The first real turn decides it: a digest run opens with the prompt as a user
    // message; any other opening is a genuine session.
    return classified.role === "user" && classified.text.startsWith(DIGEST_PROMPT_SIGNATURE);
  }
  return false;
};

// Incrementally index every session file. `full` clears the per-file cursors so
// every file is re-read from the start; dedup on message UUID makes that safe.
export const runIndex = (db: Database, full = false): IndexResult => {
  if (full) db.run("DELETE FROM index_state");

  const before = (db.query("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;
  const files = discoverSessionFiles();
  const saveState = db.query(
    `INSERT INTO index_state (source_file, bytes_indexed, mtime_ms, indexed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(source_file) DO UPDATE SET
       bytes_indexed = excluded.bytes_indexed,
       mtime_ms      = excluded.mtime_ms,
       indexed_at    = excluded.indexed_at`,
  );

  let filesIndexed = 0;
  eachIndexableFile(
    db,
    files,
    full,
    ({ file, plan, lines, cursor }) => {
      // A mid-write file (cursor unchanged) inserts nothing, but unlike the dry run
      // we do not skip it: running saveState still records the new mtime, so a
      // touched-but-unchanged file settles to "unchanged" on the next run.
      const tx = db.transaction(() => {
        if (file.kind === "session" && plan.start === 0 && isDigestRunTranscript(lines)) {
          // cerebro's own digest summarization transcript, not a session: advance the
          // cursor so it is never re-scanned, but index none of it.
          saveState.run(file.path, cursor, file.mtimeMs, new Date().toISOString());
          return;
        }
        const meta = ingestLines(db, file, lines);
        saveState.run(file.path, cursor, file.mtimeMs, new Date().toISOString());
        if (file.kind === "subagent") touchParentSession(db, file.sessionId, meta);
        else upsertSession(db, meta);
      });
      // The transaction rolls back that file's partial work if it throws.
      tx();
      filesIndexed++;
    },
    {
      // Isolate per-file failures (an unreadable or corrupt file) so one bad file
      // does not abort the whole run and skip relinkThreads / markDeletedBodies.
      onError: (file, error) => console.error(`cerebro: skipped ${file.path}: ${error.message}`),
    },
  );

  markDeletedBodies(db, files);
  relinkThreads(db);

  const after = (db.query("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;
  return { newMessages: after - before, filesScanned: files.length, filesIndexed };
};

const countMessages = (lines: string[]): number => {
  let count = 0;
  for (const line of lines) {
    if (!line) continue;
    const parsed = parseLine(line);
    if (parsed !== undefined && classify(parsed).kind === "message") count++;
  }
  return count;
};

export interface DryRunResult {
  full: boolean;
  filesScanned: number;
  filesToRead: number;
  newFiles: number;
  grownFiles: number;
  truncatedFiles: number;
  unchangedFiles: number;
  newBytes: number;
  candidateMessages: number;
}

// Report what an index run would do, writing nothing. Reads only index_state plus
// the new bytes of changed files, and applies the exact same skip/cursor logic as
// runIndex so the numbers match what a real run would process. `candidateMessages`
// is counted before UUID dedup: in incremental mode new bytes are genuinely new so
// it equals net-new, but a `--full` dry run reports the whole archive (dedup would
// then collapse it to ~0 net-new).
export const dryRunIndex = (db: Database, full = false): DryRunResult => {
  const files = discoverSessionFiles();

  const result: DryRunResult = {
    full,
    filesScanned: files.length,
    filesToRead: 0,
    newFiles: 0,
    grownFiles: 0,
    truncatedFiles: 0,
    unchangedFiles: 0,
    newBytes: 0,
    candidateMessages: 0,
  };

  eachIndexableFile(
    db,
    files,
    full,
    ({ file, plan, lines, cursor }) => {
      if (cursor === plan.start) return; // mid-write, nothing indexable yet

      // A digest summarization transcript is indexed as nothing by a real run, so the
      // dry run must not count it either (invariant: dry-run numbers match a real run).
      if (file.kind === "session" && plan.start === 0 && isDigestRunTranscript(lines)) return;

      // In full mode every file re-reads from 0; the run does not categorize files
      // as new/grown/truncated, so skip those counters (preserving prior behaviour).
      if (!full) {
        if (plan.status === "new") result.newFiles++;
        else if (plan.status === "truncated") result.truncatedFiles++;
        else result.grownFiles++;
      }
      result.filesToRead++;
      result.newBytes += cursor - plan.start;
      result.candidateMessages += countMessages(lines);
    },
    { onUnchanged: () => result.unchangedFiles++ },
  );

  return result;
};
