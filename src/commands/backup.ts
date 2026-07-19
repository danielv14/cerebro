import { runBackup } from "../backup.ts";
import { humanBytes } from "../render.ts";
import type { CommandContext } from "./context.ts";

// `backup` output: where the snapshot landed, its size, and anything pruned.
export const backupReport = (result: {
  path: string;
  bytes: number;
  pruned: string[];
}): string[] => {
  const lines = [`Backup written: ${result.path} (${humanBytes(result.bytes)})`];
  for (const pruned of result.pruned) lines.push(`Pruned old backup: ${pruned}`);
  return lines;
};

// The `backup` command: snapshot the database via VACUUM INTO, optionally pruning
// old default-named snapshots with --keep.
export const backupCommand = ({ db, io, values, dbPath, fail }: CommandContext): void => {
  let keep: number | undefined;
  if (values.keep !== undefined) {
    keep = Number(values.keep);
    if (!Number.isInteger(keep) || keep < 1) {
      fail(`--keep must be a positive integer (got "${values.keep}")`);
      return;
    }
  }
  for (const line of backupReport(runBackup(db, dbPath, { to: values.to, keep }))) {
    io.log(line);
  }
};
