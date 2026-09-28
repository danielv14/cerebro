import type { Database } from "bun:sqlite";
import { count } from "./db.ts";
import { reattachSummaries } from "./digest/store.ts";
import { createGitResolver, type GitResolver } from "./git.ts";
import {
  cursorWriter,
  eachIndexableFile,
  fileVerdict,
  orphanedCursorPaths,
  pruneCursors,
  resetCursors,
} from "./scan.ts";
import type { SessionFile, SourceAdapter } from "./sources/adapter.ts";
import { adapterFor, discoverAllSessionFiles } from "./sources/registry.ts";
import { relinkThreads } from "./thread.ts";

interface FileMeta {
  sessionId: string;
  projectDir: string | null;
  sourceFile: string;
  provider: string;
  cwd: string | null;
  gitBranch: string | null;
  model: string | null;
  title: string | null;
  titlePriority: number;
}

// The rebuild upsert deliberately does NOT refresh session_id: attribution
// belongs to the first owner (invariant #4), and a resume file re-read in
// rebuild mode must not steal the shared prefix.
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
      if (classified.model) meta.model = classified.model;
    } else if (classified.kind === "title") {
      if (classified.priority >= meta.titlePriority) {
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

// upsertSession and touchParentSession stay two functions (invariant #7): they
// differ only in which operand wins each COALESCE, and merging them behind a
// flag hides exactly that.

// The stored title_priority decides the title, with >= so a renewed same-priority
// title still replaces the old.
const upsertSession = (db: Database, meta: FileMeta, resolveGit: GitResolver): void => {
  const existing = db
    .query(`SELECT cwd FROM sessions WHERE session_id = ?`)
    .get(meta.sessionId) as { cwd: string | null } | null;

  const cwd = meta.cwd ?? existing?.cwd ?? null;
  const git = resolveGit(cwd);
  const agg = sessionAggregate(db, meta.sessionId);

  db.query(
    `INSERT INTO sessions (
       session_id, root_session_id, project_dir, project_path, cwd, git_root,
       git_remote, git_branch, source_file, provider, model, title, title_priority,
       first_ts, last_ts, msg_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  );
};

const touchParentSession = (db: Database, parentId: string, meta: FileMeta): void => {
  const agg = sessionAggregate(db, parentId);

  db.query(
    `INSERT INTO sessions (
       session_id, root_session_id, project_dir, project_path, cwd, git_root,
       git_remote, git_branch, source_file, provider, model, title, title_priority,
       first_ts, last_ts, msg_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  );
};

// The one writer of body_available. A NULL source_file is a subagent-only parent
// stub whose top-level transcript was never seen: nothing was deleted, so it stays 1.
const reconcilePresence = (db: Database, files: SessionFile[]): void => {
  // null = an empty scan (transient readdir failure): bail rather than flag the
  // whole archive body-unavailable and wipe every cursor.
  const orphans = orphanedCursorPaths(db, files);
  if (orphans === null) return;

  db.run("DROP TABLE IF EXISTS _present");
  db.run("CREATE TEMP TABLE _present (p TEXT PRIMARY KEY)");
  const insert = db.query("INSERT OR IGNORE INTO _present (p) VALUES (?)");
  const fill = db.transaction(() => {
    for (const file of files) insert.run(file.path);
  });
  fill();
  db.run(
    `UPDATE sessions
       SET body_available = CASE
             WHEN source_file IS NULL OR source_file IN (SELECT p FROM _present) THEN 1
             ELSE 0 END`,
  );
  db.run("DROP TABLE _present");
  pruneCursors(db, orphans);
};

export interface IndexResult {
  newMessages: number;
  filesScanned: number;
  filesIndexed: number;
  relinked: boolean;
}

export interface IndexOptions {
  adapters: SourceAdapter[];
  full?: boolean;
  rebuild?: boolean;
  resolveGit?: GitResolver;
  onSkip?: (line: string) => void;
}

export const runIndex = (db: Database, opts: IndexOptions): IndexResult => {
  const rebuild = opts.rebuild ?? false;
  const readAll = (opts.full ?? false) || rebuild;
  if (readAll) resetCursors(db);

  const before = count(db, "SELECT COUNT(*) AS c FROM messages");
  const adapters = opts.adapters;
  const resolveGit = opts.resolveGit ?? createGitResolver();
  const files = discoverAllSessionFiles(adapters);
  const saveCursor = cursorWriter(db);

  let filesIndexed = 0;
  eachIndexableFile(
    db,
    files,
    readAll,
    (scanned) => {
      const { file, lines, cursor } = scanned;
      const classify = adapterFor(file.provider, adapters).classifyLines;
      const verdict = fileVerdict(scanned, classify);
      // A mid-write file still gets its cursor saved (the dry run only counts it):
      // recording the new mtime lets a touched-but-unchanged file settle to
      // "unchanged".
      const tx = db.transaction((): boolean => {
        saveCursor(file, cursor, verdict === "digest");
        if (verdict !== "ingest") return false;
        const meta = ingestLines(db, file, lines, classify, rebuild);
        if (file.kind === "subagent") touchParentSession(db, file.sessionId, meta);
        else upsertSession(db, meta, resolveGit);
        return true;
      });
      if (tx()) filesIndexed++;
    },
    {
      onError: (file, error) => opts.onSkip?.(`cerebro: skipped ${file.path}: ${error.message}`),
    },
  );

  // Unconditional: a source file can vanish without anything being indexed.
  reconcilePresence(db, files);
  // Gated on filesIndexed, not the message delta: a file can contribute only
  // title events, and a no-op run must stay O(files discovered).
  const relinked = filesIndexed > 0;
  if (relinked) {
    db.transaction(() => {
      relinkThreads(db);
      reattachSummaries(db);
    })();
  }

  const after = count(db, "SELECT COUNT(*) AS c FROM messages");
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
  // Read but not indexable: a digest transcript, or a mid-write file with no
  // complete line yet.
  skippedFiles: number;
  newBytes: number;
  candidateMessages: number;
}

export const dryRunIndex = (
  db: Database,
  adapters: SourceAdapter[],
  full = false,
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
    skippedFiles: 0,
    newBytes: 0,
    candidateMessages: 0,
  };

  eachIndexableFile(
    db,
    files,
    full,
    (scanned) => {
      const { file, plan, lines, cursor } = scanned;
      const classify = adapterFor(file.provider, adapters).classifyLines;
      if (fileVerdict(scanned, classify) !== "ingest") {
        result.skippedFiles++;
        return;
      }

      if (!full) {
        if (plan.status === "new") result.newFiles++;
        else if (plan.status === "truncated") result.truncatedFiles++;
        else result.grownFiles++;
      }
      result.filesToRead++;
      result.newBytes += cursor - plan.start;
      result.candidateMessages += countMessages(lines, classify);
    },
    {
      onUnread: ({ status }) => {
        if (status === "skipped") result.skippedFiles++;
        else result.unchangedFiles++;
      },
    },
  );

  return result;
};
