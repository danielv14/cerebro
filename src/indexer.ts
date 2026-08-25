import type { Database } from "bun:sqlite";
import { DIGEST_PROMPT_SIGNATURE } from "./digest-signature.ts";
import { gitInfo } from "./git.ts";
import { eachIndexableFile, orphanedCursorPaths } from "./scan.ts";
import type { SessionFile, SourceAdapter } from "./sources/adapter.ts";
import { adapterFor, discoverAllSessionFiles, sourceAdapters } from "./sources/registry.ts";
import { relinkThreads } from "./thread.ts";

interface FileMeta {
  sessionId: string;
  projectDir: string;
  sourceFile: string;
  provider: string;
  cwd: string | null;
  gitBranch: string | null;
  // The model recorded on this batch's turns (first non-null seen), so the session
  // row tracks which model served it. Stays null when no turn in the batch names one.
  model: string | null;
  title: string | null;
  titlePriority: number;
}

// Insert any new messages from a file's freshly-split lines and harvest the
// metadata for its session row. The bytes were already read and split by
// eachIndexableFile; this is the write half, run inside the per-file transaction.
//
// `rebuild` switches the dedup from ignore to refresh: still keyed on the message
// UUID (invariant #4), but an existing row gets its payload (text, ts, role,
// parent_uuid, is_sidechain) re-written from the fresh parse, so a changed
// flattenContent reaches already-indexed messages. session_id is deliberately NOT
// refreshed: attribution belongs to the first owner (invariant #6), and a resume
// file re-read in rebuild mode must not steal the shared prefix. Messages whose
// source file is gone are simply never re-read, so their only copy stays intact.
const ingestLines = (
  db: Database,
  file: SessionFile,
  lines: string[],
  classify: SourceAdapter["classifyLines"],
  rebuild = false,
): FileMeta => {
  const meta: FileMeta = {
    sessionId: file.sessionId,
    projectDir: file.projectDir,
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
      // Attribute every message to the file's owning session id. For a top-level
      // file that is its own UUID; for a subagent file it is the parent session,
      // so the sidechain folds into the parent thread. Resumes write fresh files
      // with new UUIDs; cross-file threading is rebuilt later by relinkThreads.
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
      if (!meta.model && classified.model) meta.model = classified.model;
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
//
// The title is the exception: an incremental run only sees the *new* lines, so its
// batch-local title may be lower-priority than the one already stored (e.g. a later
// `summary` event must never clobber a `custom-title` indexed earlier). The stored
// title_priority decides: the incoming title wins only when it is non-NULL and its
// priority is >= the stored one (>= so a fresh same-priority title, like a renewed
// ai-title, still replaces the old).
//
// Kept separate from touchParentSession on purpose (invariant #7): the COALESCE
// direction and this title CASE are the whole difference between the two, so do not
// merge them into one builder behind a flag.
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

// A subagent file's messages belong to the parent session. Ensure that parent row
// exists and refresh its aggregate, but never clobber the parent's identity fields,
// which are owned by its top-level file. Here the existing row wins the merge:
// COALESCE prefers sessions, so the values this passes (project_dir, project_path,
// cwd, git_branch, provider, model) only fill a not-yet-seen parent and never
// overwrite the top-level's (a subagent may run a different model than its parent,
// which is exactly why sessions.model wins here). The fields a subagent cannot know (git_root, git_remote, source_file,
// title) are passed NULL, so on a pure-subagent stub source_file stays NULL and the
// row reads as body-unavailable.
//
// Kept separate from upsertSession on purpose (invariant #7): the reversed COALESCE
// direction plus the frozen title_priority are the whole difference between the two,
// so do not merge them into one builder behind a flag.
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

// Reconcile the archive against what is actually on disk, in two ways against the
// same temp table of present paths: flag sessions whose source file is gone as
// body-unavailable (and re-flag present ones as available), and drop index_state
// cursors for files that no longer exist. A temp table keeps both correct and cheap
// regardless of how many files there are.
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
  // A NULL source_file (a parent stub created only from subagent files, whose
  // top-level transcript is not on disk) is correctly treated as unavailable.
  db.run(
    `UPDATE sessions
       SET body_available = CASE WHEN source_file IN (SELECT p FROM _present) THEN 1 ELSE 0 END`,
  );
  db.run("DROP TABLE _present");
  // Unlike sessions and messages, where the row *is* the archive (invariant #4), an
  // index_state row for a file that is gone carries no information: it is a byte
  // cursor into something unreadable. Claude Code deletes session files on its own
  // schedule, so without this the one table that is meant to be a working cursor set
  // grows forever. The rows to drop come from orphanedCursorPaths (the same reader
  // doctor counts through), so only rows whose file is absent go and an is_digest
  // flag on a file that still exists is never lost. A pruned file that later
  // reappears is simply re-read from byte 0 and UUID dedup makes that a no-op, so
  // this cannot resurrect or duplicate anything.
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
  // Whether relinkThreads ran. Not reported to the user; it exists so the
  // no-op gate in runIndex is directly observable.
  relinked: boolean;
}

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
const isDigestRunTranscript = (
  lines: string[],
  classify: SourceAdapter["classifyLines"],
): boolean => {
  for (const classified of classify(lines)) {
    if (classified.kind !== "message") continue;
    // The first real turn decides it: a digest run opens with the prompt as a user
    // message; any other opening is a genuine session.
    return classified.role === "user" && classified.text.startsWith(DIGEST_PROMPT_SIGNATURE);
  }
  return false;
};

// Incrementally index every session file. `full` clears the per-file cursors so
// every file is re-read from the start; dedup on message UUID makes that safe.
// `rebuild` (implies full) additionally re-flattens already-indexed messages in
// place (see ingestLines): the only way a flattenContent change reaches old rows,
// since plain dedup ignores re-reads. It never deletes anything, so messages whose
// source Claude Code already removed are untouched.
// A run that indexes nothing is O(files discovered), not O(archive): the relink
// pass is skipped (see below), which is what keeps the synchronous /clear hook
// cheap on a large archive.
export interface IndexOptions {
  full?: boolean;
  // Implies full.
  rebuild?: boolean;
  // The sources to index. Defaults to every registered adapter; injectable so a
  // test can index through a fake source without touching the registry.
  adapters?: SourceAdapter[];
  // Where the per-file skip message goes when a file cannot be read or ingested
  // (the run continues without it). The CLI injects its output sink; a direct
  // library caller that omits it accepts silent skips, which IndexResult's
  // filesIndexed vs filesScanned still exposes.
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
      // we do not skip it: running saveState still records the new mtime, so a
      // touched-but-unchanged file settles to "unchanged" on the next run.
      const tx = db.transaction(() => {
        if (file.kind === "session" && plan.start === 0 && isDigestRunTranscript(lines, classify)) {
          // cerebro's own digest summarization transcript, not a session: flag it so
          // it is never read again (even if it grows), and index none of it.
          saveState.run(file.path, cursor, file.mtimeMs, new Date().toISOString(), 1);
          return;
        }
        const meta = ingestLines(db, file, lines, classify, rebuild);
        saveState.run(file.path, cursor, file.mtimeMs, new Date().toISOString(), 0);
        if (file.kind === "subagent") touchParentSession(db, file.sessionId, meta);
        else upsertSession(db, meta);
      });
      // The transaction rolls back that file's partial work if it throws.
      tx();
      filesIndexed++;
    },
    {
      // Isolate per-file failures (an unreadable or corrupt file) so one bad file
      // does not abort the whole run and skip relinkThreads / reconcilePresence.
      onError: (file, error) => opts.onSkip?.(`cerebro: skipped ${file.path}: ${error.message}`),
    },
  );

  // Unconditional: a source file can vanish from disk without anything being
  // indexed, and that is exactly what flips body_available to 0 and orphans a cursor.
  reconcilePresence(db, files);
  // A run that read no file inserted no message, so no new cross-session parent
  // link can exist and root_session_id cannot have changed. Skipping the relink
  // keeps a no-op index O(files discovered) instead of O(archive). The gate is on
  // filesIndexed, not on the message delta: a file can be read and contribute only
  // title events, and a future change to what counts as indexable must not
  // silently disable relinking.
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

// Report what an index run would do, writing nothing. Reads only index_state plus
// the new bytes of changed files, and applies the exact same skip/cursor logic as
// runIndex so the numbers match what a real run would process. `candidateMessages`
// is counted before UUID dedup: in incremental mode new bytes are genuinely new so
// it equals net-new, but a `--full` dry run reports the whole archive (dedup would
// then collapse it to ~0 net-new).
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

      // A digest summarization transcript is indexed as nothing by a real run, so the
      // dry run must not count it either (invariant: dry-run numbers match a real run).
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
