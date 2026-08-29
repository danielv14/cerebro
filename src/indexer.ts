import type { Database } from "bun:sqlite";
import { DIGEST_PROMPT_SIGNATURE } from "./digest-signature.ts";
import { gitInfo } from "./git.ts";
import { eachIndexableFile, orphanedCursorPaths } from "./scan.ts";
import type { SessionFile, SourceAdapter } from "./sources/adapter.ts";
import { adapterFor, discoverAllSessionFiles, sourceAdapters } from "./sources/registry.ts";
import { relinkThreads } from "./thread.ts";

// Design notes: docs/architecture.md ("Indexer").

interface FileMeta {
  sessionId: string;
  projectDir: string | null;
  sourceFile: string;
  provider: string;
  cwd: string | null;
  gitBranch: string | null;
  // Last non-null model seen in the batch; null keeps the previously stored one.
  model: string | null;
  title: string | null;
  titlePriority: number;
}

// `rebuild` switches the dedup from ignore to refresh: still keyed on the message
// UUID (invariant #4), but the payload is re-written from the fresh parse.
// session_id is deliberately NOT refreshed: attribution belongs to the first owner
// (invariant #6), and a resume file re-read in rebuild mode must not steal the
// shared prefix.
const ingestLines = (
  db: Database,
  file: SessionFile,
  lines: string[],
  classify: SourceAdapter["classifyLines"],
  rebuild = false,
): FileMeta => {
  const meta: FileMeta = {
    sessionId: file.sessionId,
    projectDir: file.projectDir ?? null,
    sourceFile: file.path,
    provider: file.provider,
    cwd: null,
    gitBranch: null,
    model: null,
    title: null,
    titlePriority: 0,
  };

  const insert = db.query(
    rebuild
      ? `INSERT INTO messages (uuid, session_id, parent_uuid, ts, role, text, is_sidechain)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uuid) DO UPDATE SET
           parent_uuid  = excluded.parent_uuid,
           ts           = excluded.ts,
           role         = excluded.role,
           text         = excluded.text,
           is_sidechain = excluded.is_sidechain`
      : `INSERT OR IGNORE INTO messages (uuid, session_id, parent_uuid, ts, role, text, is_sidechain)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const classified of classify(lines)) {
    if (classified.kind === "message") {
      // meta.sessionId is the file's owning session (invariant #6): a subagent
      // file's messages fold into the parent thread.
      insert.run(
        classified.uuid,
        meta.sessionId,
        classified.parentUuid,
        classified.ts,
        classified.role,
        classified.text,
        classified.isSidechain ? 1 : 0,
      );
      if (!meta.cwd && classified.cwd) meta.cwd = classified.cwd;
      if (!meta.gitBranch && classified.gitBranch) meta.gitBranch = classified.gitBranch;
      // Last non-null wins: combined with upsertSession's incoming-wins COALESCE,
      // every indexing path converges on the file's last recorded model regardless
      // of how the bytes were batched.
      if (classified.model) meta.model = classified.model;
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

const sessionAggregate = (db: Database, sessionId: string): SessionAggregate =>
  db
    .query(
      `SELECT COUNT(*) AS c, MIN(ts) AS mn, MAX(ts) AS mx
       FROM messages WHERE session_id = ?`,
    )
    .get(sessionId) as SessionAggregate;

// The two session-row writers differ only in which operand wins the per-column
// COALESCE on conflict, plus the title CASE. Kept as two functions on purpose
// (invariant #7): merging them behind a flag hides the one thing that differs.

// Top-level file: the authority for its session, so the incoming value wins.
// The title is the exception: an incremental run only sees the *new* lines, so the
// stored title_priority decides. >= (not >) so a fresh same-priority title, like a
// renewed ai-title, still replaces the old.
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
       git_remote, git_branch, source_file, provider, model, title, title_priority,
       first_ts, last_ts, msg_count, body_available
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       project_dir    = COALESCE(excluded.project_dir, sessions.project_dir),
       project_path   = COALESCE(excluded.project_path, sessions.project_path),
       cwd            = COALESCE(excluded.cwd, sessions.cwd),
       git_root       = COALESCE(excluded.git_root, sessions.git_root),
       git_remote     = COALESCE(excluded.git_remote, sessions.git_remote),
       git_branch     = COALESCE(excluded.git_branch, sessions.git_branch),
       source_file    = COALESCE(excluded.source_file, sessions.source_file),
       provider       = COALESCE(excluded.provider, sessions.provider),
       model          = COALESCE(excluded.model, sessions.model),
       title          = CASE
                          WHEN excluded.title IS NOT NULL
                           AND excluded.title_priority >= sessions.title_priority
                          THEN excluded.title ELSE sessions.title END,
       title_priority = CASE
                          WHEN excluded.title IS NOT NULL
                           AND excluded.title_priority >= sessions.title_priority
                          THEN excluded.title_priority ELSE sessions.title_priority END,
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
    meta.provider,
    meta.model,
    meta.title,
    meta.titlePriority,
    agg.mn,
    agg.mx,
    agg.c,
    1,
  );
};

// Subagent file: ensure the parent row exists and refresh its aggregate, but the
// existing row wins, so a subagent only fills a not-yet-seen parent and never
// clobbers the top-level's values (a subagent may run a different model than its
// parent). The fields a subagent cannot know (git_root, git_remote, source_file,
// title) are passed NULL, so a pure-subagent stub reads as body-unavailable.
const touchParentSession = (db: Database, parentId: string, meta: FileMeta): void => {
  const agg = sessionAggregate(db, parentId);

  db.query(
    `INSERT INTO sessions (
       session_id, root_session_id, project_dir, project_path, cwd, git_root,
       git_remote, git_branch, source_file, provider, model, title, title_priority,
       first_ts, last_ts, msg_count, body_available
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       project_dir    = COALESCE(sessions.project_dir, excluded.project_dir),
       project_path   = COALESCE(sessions.project_path, excluded.project_path),
       cwd            = COALESCE(sessions.cwd, excluded.cwd),
       git_root       = COALESCE(sessions.git_root, excluded.git_root),
       git_remote     = COALESCE(sessions.git_remote, excluded.git_remote),
       git_branch     = COALESCE(sessions.git_branch, excluded.git_branch),
       source_file    = COALESCE(sessions.source_file, excluded.source_file),
       provider       = COALESCE(sessions.provider, excluded.provider),
       model          = COALESCE(sessions.model, excluded.model),
       title          = COALESCE(sessions.title, excluded.title),
       title_priority = sessions.title_priority,
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
    meta.provider,
    meta.model,
    null,
    0,
    agg.mn,
    agg.mx,
    agg.c,
    1,
  );
};

// Reconcile the archive against what is on disk: flag sessions whose source file
// is gone as body-unavailable and drop index_state cursors for vanished files.
const reconcilePresence = (db: Database, files: SessionFile[]): void => {
  // null = an empty scan, which orphanedCursorPaths treats as a transient readdir
  // failure. Bail rather than flag the whole archive body-unavailable and wipe
  // every cursor.
  const orphans = orphanedCursorPaths(db, files);
  if (orphans === null) return;

  db.run("DROP TABLE IF EXISTS _present");
  db.run("CREATE TEMP TABLE _present (p TEXT PRIMARY KEY)");
  const insert = db.query("INSERT OR IGNORE INTO _present (p) VALUES (?)");
  const fill = db.transaction(() => {
    for (const file of files) insert.run(file.path);
  });
  fill();
  // A NULL source_file (a parent stub created only from subagent files) is
  // correctly treated as unavailable.
  db.run(
    `UPDATE sessions
       SET body_available = CASE WHEN source_file IN (SELECT p FROM _present) THEN 1 ELSE 0 END`,
  );
  db.run("DROP TABLE _present");
  // A pruned file that later reappears is re-read from byte 0 and UUID dedup makes
  // that a no-op, so this cannot resurrect or duplicate anything.
  const drop = db.query("DELETE FROM index_state WHERE source_file = ?");
  const prune = db.transaction(() => {
    for (const path of orphans) drop.run(path);
  });
  prune();
};

export interface IndexResult {
  newMessages: number;
  filesScanned: number;
  filesIndexed: number;
  // Whether relinkThreads ran; exists so the no-op gate is directly observable.
  relinked: boolean;
}

// True when these lines are cerebro's own headless summarization run rather than a
// real session (its first turn is the digest prompt as a user message). Caller
// gates on plan.start === 0 so it only inspects a file read whole from the start,
// never a mid-file incremental read whose first line is an arbitrary turn.
const isDigestRunTranscript = (
  lines: string[],
  classify: SourceAdapter["classifyLines"],
): boolean => {
  for (const classified of classify(lines)) {
    if (classified.kind !== "message") continue;
    return classified.role === "user" && classified.text.startsWith(DIGEST_PROMPT_SIGNATURE);
  }
  return false;
};

export interface IndexOptions {
  full?: boolean;
  // Implies full.
  rebuild?: boolean;
  // Defaults to every registered adapter; injectable so a test can index through a
  // fake source without touching the registry.
  adapters?: SourceAdapter[];
  // Where the per-file skip message goes when a file cannot be read or ingested
  // (the run continues without it).
  onSkip?: (line: string) => void;
}

export const runIndex = (db: Database, opts: IndexOptions = {}): IndexResult => {
  const rebuild = opts.rebuild ?? false;
  const readAll = (opts.full ?? false) || rebuild;
  if (readAll) db.run("DELETE FROM index_state");

  const before = (db.query("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;
  const adapters = opts.adapters ?? sourceAdapters();
  const files = discoverAllSessionFiles(adapters);
  const saveState = db.query(
    `INSERT INTO index_state (source_file, bytes_indexed, mtime_ms, indexed_at, is_digest)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source_file) DO UPDATE SET
       bytes_indexed = excluded.bytes_indexed,
       mtime_ms      = excluded.mtime_ms,
       indexed_at    = excluded.indexed_at,
       is_digest     = excluded.is_digest`,
  );

  let filesIndexed = 0;
  eachIndexableFile(
    db,
    files,
    readAll,
    ({ file, plan, lines, cursor }) => {
      const classify = adapterFor(file.provider, adapters).classifyLines;
      // A mid-write file (cursor unchanged) inserts nothing, but unlike the dry run
      // we do not skip it: saveState records the new mtime, so a touched-but-
      // unchanged file settles to "unchanged" on the next run.
      const tx = db.transaction(() => {
        if (file.kind === "session" && plan.start === 0 && isDigestRunTranscript(lines, classify)) {
          // Flagged so it is never read again (even if it grows), and none of it
          // is indexed.
          saveState.run(file.path, cursor, file.mtimeMs, new Date().toISOString(), 1);
          return;
        }
        const meta = ingestLines(db, file, lines, classify, rebuild);
        saveState.run(file.path, cursor, file.mtimeMs, new Date().toISOString(), 0);
        if (file.kind === "subagent") touchParentSession(db, file.sessionId, meta);
        else upsertSession(db, meta);
      });
      tx();
      filesIndexed++;
    },
    {
      // One bad file must not abort the whole run and skip relinkThreads /
      // reconcilePresence.
      onError: (file, error) => opts.onSkip?.(`cerebro: skipped ${file.path}: ${error.message}`),
    },
  );

  // Unconditional: a source file can vanish without anything being indexed, and
  // that is exactly what flips body_available and orphans a cursor.
  reconcilePresence(db, files);
  // A run that read no file inserted no message, so root_session_id cannot have
  // changed; skipping the relink keeps a no-op index O(files discovered). Gated on
  // filesIndexed, not the message delta: a file can contribute only title events.
  const relinked = filesIndexed > 0;
  if (relinked) relinkThreads(db);

  const after = (db.query("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;
  return { newMessages: after - before, filesScanned: files.length, filesIndexed, relinked };
};

const countMessages = (lines: string[], classify: SourceAdapter["classifyLines"]): number => {
  let count = 0;
  for (const classified of classify(lines)) {
    if (classified.kind === "message") count++;
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

// Applies the exact same skip/cursor logic as runIndex, writing nothing.
// `candidateMessages` is counted before UUID dedup: incremental bytes are genuinely
// new so it equals net-new, but a --full dry run reports the whole archive.
export const dryRunIndex = (
  db: Database,
  full = false,
  adapters: SourceAdapter[] = sourceAdapters(),
): DryRunResult => {
  const files = discoverAllSessionFiles(adapters);

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
      const classify = adapterFor(file.provider, adapters).classifyLines;

      // Indexed as nothing by a real run, so not counted here either (invariant #2:
      // dry-run numbers match a real run).
      if (file.kind === "session" && plan.start === 0 && isDigestRunTranscript(lines, classify))
        return;

      // In full mode every file re-reads from 0; the run does not categorize files
      // as new/grown/truncated, so skip those counters.
      if (!full) {
        if (plan.status === "new") result.newFiles++;
        else if (plan.status === "truncated") result.truncatedFiles++;
        else result.grownFiles++;
      }
      result.filesToRead++;
      result.newBytes += cursor - plan.start;
      result.candidateMessages += countMessages(lines, classify);
    },
    { onUnchanged: () => result.unchangedFiles++ },
  );

  return result;
};
