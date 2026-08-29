import type { Database } from "bun:sqlite";
import fs from "node:fs";
import { parseLine, type SessionFile } from "./sources/adapter.ts";

// The source-file scan layer: bytes, cursors, mtimes and index_state. One splitter
// and one read plan shared by runIndex and dryRunIndex (invariant #2). Design
// notes: docs/architecture.md ("Scan layer").

// Bytes, not characters, because the per-file cursor is a byte offset; 0x0A never
// appears inside a UTF-8 multibyte sequence, so splitting on newline is safe.
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

// The cursor only advances past a trailing '\n' (or a final line that parses
// cleanly without one), so a half-written last line is left for next time
// (invariant #1).
export const splitBuffer = (buf: Buffer, start: number): { lines: string[]; cursor: number } => {
  // With no newline at all, lastNewline is -1: lines start empty, the cursor stays
  // at `start` (-1 + 1 = 0), and the whole buffer is the tail, so the one rule
  // below covers a buffer with and without newlines alike.
  const lastNewline = buf.lastIndexOf(0x0a);
  const lines = lastNewline >= 0 ? buf.subarray(0, lastNewline).toString("utf8").split("\n") : [];
  let cursor = start + lastNewline + 1;

  const tail = buf
    .subarray(lastNewline + 1)
    .toString("utf8")
    .trim();
  if (tail && parseLine(tail) !== undefined) {
    lines.push(tail);
    cursor = start + buf.length;
  }
  // An unparseable tail is a mid-write line: leave it for the next run.
  return { lines, cursor };
};

export type FileStatus = "new" | "grown" | "truncated" | "unchanged";

export interface FileReadPlan {
  start: number; // byte offset to read from
  status: FileStatus;
  shouldRead: boolean; // false only when unchanged (and not full)
}

export const planFileRead = (
  state: { bytes_indexed: number; mtime_ms: number; is_digest?: number } | null,
  file: SessionFile,
  full: boolean,
): FileReadPlan => {
  // A file flagged as cerebro's own digest transcript is permanently excluded,
  // even when it grows: the content guard only inspects reads that start at byte
  // 0, so without this a digest transcript still being written when first detected
  // would leak its later lines on the next incremental run. Checked before `full`
  // on purpose: a real --full run has already cleared index_state, so honoring the
  // flag here only affects a --full *dry run*, which must report the file as
  // skipped to match.
  if (state?.is_digest) {
    return { start: state.bytes_indexed, status: "unchanged", shouldRead: false };
  }

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

// The one owner of the orphan predicate: the indexer prunes through this and
// doctor counts through it. Returns null on an empty scan, which almost always
// means a transient readdir failure rather than every session being deleted, so
// "unknown" stays distinguishable from "no orphans".
export const orphanedCursorPaths = (db: Database, files: SessionFile[]): string[] | null => {
  if (files.length === 0) return null;
  const present = new Set(files.map((file) => file.path));
  const cursors = db.query("SELECT source_file FROM index_state").all() as {
    source_file: string;
  }[];
  return cursors.map((row) => row.source_file).filter((path) => !present.has(path));
};

export interface ScannedFile {
  file: SessionFile;
  plan: FileReadPlan;
  lines: string[];
  cursor: number;
}

// The single scan shared by runIndex and dryRunIndex. What to do with the result
// (write vs count) and how to treat a mid-write file is left to `handle`.
// `onError` isolates a per-file failure so one bad file does not abort the whole
// run; without it the error propagates, which is what the dry run wants.
export const eachIndexableFile = (
  db: Database,
  files: SessionFile[],
  full: boolean,
  handle: (scanned: ScannedFile) => void,
  opts: { onUnchanged?: () => void; onError?: (file: SessionFile, error: Error) => void } = {},
): void => {
  const getState = db.query(
    "SELECT bytes_indexed, mtime_ms, is_digest FROM index_state WHERE source_file = ?",
  );

  for (const file of files) {
    const state = getState.get(file.path) as {
      bytes_indexed: number;
      mtime_ms: number;
      is_digest: number;
    } | null;

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
