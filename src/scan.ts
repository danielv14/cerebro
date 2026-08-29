import type { Database } from "bun:sqlite";
import fs from "node:fs";
import { parseLine, type SessionFile } from "./sources/adapter.ts";

// Design notes: docs/architecture.md ("Scan layer").

// Bytes, not characters: the per-file cursor is a byte offset, and 0x0A never
// appears inside a UTF-8 multibyte sequence, so a newline split is safe.
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

// The cursor only advances past a trailing '\n', or past a final line that parses
// cleanly without one; an unparseable tail is a mid-write line left for the next
// run (invariant #1).
export const splitBuffer = (buf: Buffer, start: number): { lines: string[]; cursor: number } => {
  // No newline at all gives lastNewline -1: lines stay empty, the cursor stays at
  // `start`, and the whole buffer is the tail, so one rule covers both cases.
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
  return { lines, cursor };
};

export type FileStatus = "new" | "grown" | "truncated" | "unchanged";

export interface FileReadPlan {
  start: number;
  status: FileStatus;
  shouldRead: boolean; // false only when unchanged (and not full)
}

export const planFileRead = (
  state: { bytes_indexed: number; mtime_ms: number; is_digest?: number } | null,
  file: SessionFile,
  full: boolean,
): FileReadPlan => {
  // A digest-flagged file is permanently excluded even when it grows: the content
  // guard only inspects reads that start at byte 0. Checked before `full` on
  // purpose: a real --full run has cleared index_state, so this branch only
  // affects a --full DRY run, which must report the file as skipped to match.
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

// Returns null on an empty scan: that almost always means a transient readdir
// failure, so "unknown" stays distinguishable from "no orphans".
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

// Without `onError` a per-file failure propagates, which is what the dry run
// wants; runIndex passes one so a bad file cannot abort the whole run.
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
