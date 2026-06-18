import type { Database } from "bun:sqlite";
import fs from "node:fs";
import { discoverSessionFiles, type SessionFile } from "./paths.ts";
import { parseLine, classify } from "./jsonl.ts";
import { gitInfo } from "./git.ts";

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
    const tail = buf.subarray(lastNewline + 1).toString("utf8").trim();
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

// Read new bytes from a single file and insert any new messages. Returns the new
// byte cursor and the metadata gathered for the session row.
const indexOneFile = (
  db: Database,
  file: SessionFile,
  start: number,
): { cursor: number; meta: FileMeta } => {
  const meta: FileMeta = {
    sessionId: file.sessionId,
    projectDir: file.projectDir,
    sourceFile: file.path,
    cwd: null,
    gitBranch: null,
    title: null,
    titlePriority: 0,
  };

  const buf = readRange(file.path, start, file.size);
  const { lines, cursor } = splitBuffer(buf, start);

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

  return { cursor, meta };
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

// root_session_id defaults to the session itself on insert; relinkThreads later
// reparents resumes. This means a row is never NULL-rooted, even in the window
// before relinkThreads runs (or if a run aborts before it).
const upsertSession = (db: Database, meta: FileMeta): void => {
  const existing = db
    .query(`SELECT cwd FROM sessions WHERE session_id = ?`)
    .get(meta.sessionId) as { cwd: string | null } | null;

  const cwd = meta.cwd ?? existing?.cwd ?? null;
  const git = gitInfo(cwd);
  const agg = sessionAggregate(db, meta.sessionId);

  // COALESCE on update keeps prior values when an incremental run sees no fresh
  // cwd/branch/title (e.g. a resume that only added a couple of turns).
  // root_session_id is left untouched on conflict (relinkThreads owns it).
  db.query(
    `INSERT INTO sessions (
       session_id, root_session_id, project_dir, project_path, cwd, git_root,
       git_remote, git_branch, source_file, title, first_ts, last_ts, msg_count,
       body_available
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(session_id) DO UPDATE SET
       project_dir  = excluded.project_dir,
       project_path = COALESCE(excluded.project_path, sessions.project_path),
       cwd          = COALESCE(excluded.cwd, sessions.cwd),
       git_root     = COALESCE(excluded.git_root, sessions.git_root),
       git_remote   = COALESCE(excluded.git_remote, sessions.git_remote),
       git_branch   = COALESCE(excluded.git_branch, sessions.git_branch),
       source_file  = excluded.source_file,
       title        = COALESCE(excluded.title, sessions.title),
       first_ts     = excluded.first_ts,
       last_ts      = excluded.last_ts,
       msg_count    = excluded.msg_count,
       body_available = 1`,
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
  );
};

// A subagent file's messages belong to the parent session. Ensure that parent row
// exists and refresh its aggregate, but never clobber the parent's identity fields
// (source_file, project_dir, title, cwd) which are owned by its top-level file.
const touchParentSession = (db: Database, parentId: string, meta: FileMeta): void => {
  const agg = sessionAggregate(db, parentId);

  db.query(
    `INSERT INTO sessions (
       session_id, root_session_id, project_dir, project_path, cwd, git_branch,
       first_ts, last_ts, msg_count, body_available
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(session_id) DO UPDATE SET
       project_path = COALESCE(sessions.project_path, excluded.project_path),
       cwd          = COALESCE(sessions.cwd, excluded.cwd),
       git_branch   = COALESCE(sessions.git_branch, excluded.git_branch),
       first_ts     = excluded.first_ts,
       last_ts      = excluded.last_ts,
       msg_count    = excluded.msg_count`,
  ).run(
    parentId,
    parentId,
    meta.projectDir,
    meta.cwd,
    meta.cwd,
    meta.gitBranch,
    agg.mn,
    agg.mx,
    agg.c,
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

// Incrementally index every session file. `full` clears the per-file cursors so
// every file is re-read from the start; dedup on message UUID makes that safe.
export const runIndex = (db: Database, full = false): IndexResult => {
  if (full) db.run("DELETE FROM index_state");

  const before = (db.query("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;
  const files = discoverSessionFiles();
  const getState = db.query(
    "SELECT bytes_indexed, mtime_ms FROM index_state WHERE source_file = ?",
  );
  const saveState = db.query(
    `INSERT INTO index_state (source_file, bytes_indexed, mtime_ms, indexed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(source_file) DO UPDATE SET
       bytes_indexed = excluded.bytes_indexed,
       mtime_ms      = excluded.mtime_ms,
       indexed_at    = excluded.indexed_at`,
  );

  let filesIndexed = 0;
  for (const file of files) {
    const state = getState.get(file.path) as
      | { bytes_indexed: number; mtime_ms: number }
      | null;

    let start = state ? state.bytes_indexed : 0;
    if (start > file.size) start = 0; // truncated / rotated -> re-read

    if (state && start === file.size && state.mtime_ms === file.mtimeMs) continue;

    const tx = db.transaction(() => {
      const { cursor, meta } = indexOneFile(db, file, start);
      saveState.run(file.path, cursor, file.mtimeMs, new Date().toISOString());
      if (file.kind === "subagent") touchParentSession(db, file.sessionId, meta);
      else upsertSession(db, meta);
    });
    // Isolate per-file failures (an unreadable or corrupt file) so one bad file
    // does not abort the whole run and skip relinkThreads / markDeletedBodies.
    // The transaction rolls back that file's partial work on throw.
    try {
      tx();
      filesIndexed++;
    } catch (error) {
      console.error(`cerebro: skipped ${file.path}: ${(error as Error).message}`);
    }
  }

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
  const getState = db.query(
    "SELECT bytes_indexed, mtime_ms FROM index_state WHERE source_file = ?",
  );

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

  for (const file of files) {
    const state = getState.get(file.path) as
      | { bytes_indexed: number; mtime_ms: number }
      | null;

    let start = full ? 0 : state ? state.bytes_indexed : 0;
    let truncated = false;
    if (!full && start > file.size) {
      start = 0;
      truncated = true;
    }

    if (!full && state && start === file.size && state.mtime_ms === file.mtimeMs) {
      result.unchangedFiles++;
      continue;
    }

    const buf = readRange(file.path, start, file.size);
    const { lines, cursor } = splitBuffer(buf, start);
    if (cursor === start) continue; // mid-write, nothing indexable yet

    if (!full) {
      if (!state) result.newFiles++;
      else if (truncated) result.truncatedFiles++;
      else result.grownFiles++;
    }
    result.filesToRead++;
    result.newBytes += cursor - start;
    result.candidateMessages += countMessages(lines);
  }

  return result;
};
