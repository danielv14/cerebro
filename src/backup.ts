import type { Database } from "bun:sqlite";
import fs from "node:fs";
import { dirname, join } from "node:path";

// The archive is the only copy of every session Claude Code has already deleted,
// so it deserves a backup story of its own. VACUUM INTO is the right primitive:
// it takes a consistent snapshot even against a concurrently-writing WAL database
// and produces a compacted single file.

export interface BackupResult {
  path: string;
  bytes: number;
  pruned: string[];
}

// Lexicographically sortable timestamp for the default filename: 20260702-101530.
const stamp = (now: Date): string =>
  now
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/[-:]/g, "")
    .replace("T", "-");

const DEFAULT_NAME = /^archive-\d{8}-\d{6}\.sqlite$/;

// Snapshot the open database to `opts.to`, or to <db-dir>/backups/archive-<ts>.sqlite.
// `keep` prunes the oldest default-named backups beyond N; it only ever touches the
// default directory and the default name pattern, so a custom --to target (or any
// other file living there) is never deleted by pruning.
export const runBackup = (
  db: Database,
  dbPath: string,
  opts: { to?: string; keep?: number } = {},
  now = new Date(),
): BackupResult => {
  if (dbPath === ":memory:") throw new Error("cannot back up an in-memory database");

  const defaultDir = join(dirname(dbPath), "backups");
  const dest = opts.to ?? join(defaultDir, `archive-${stamp(now)}.sqlite`);
  if (fs.existsSync(dest)) throw new Error(`backup target already exists: ${dest}`);
  fs.mkdirSync(dirname(dest), { recursive: true });

  db.query("VACUUM INTO ?").run(dest);
  const bytes = fs.statSync(dest).size;

  const pruned: string[] = [];
  if (opts.keep !== undefined && opts.to === undefined) {
    const backups = fs
      .readdirSync(defaultDir)
      .filter((name) => DEFAULT_NAME.test(name))
      .sort();
    while (backups.length > opts.keep) {
      const victim = backups.shift()!;
      fs.rmSync(join(defaultDir, victim));
      pruned.push(join(defaultDir, victim));
    }
  }

  return { path: dest, bytes, pruned };
};
