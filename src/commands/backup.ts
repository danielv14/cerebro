import { runBackup } from "../backup.ts";
import { humanBytes } from "../render.ts";
import { type CommandContext, numberOption } from "./context.ts";

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
  const keep = numberOption(
    values.keep,
    "keep",
    { integer: true, min: 1, label: "a positive integer" },
    fail,
  );
  if (!keep.ok) return;
  for (const line of backupReport(runBackup(db, dbPath, { to: values.to, keep: keep.value }))) {
    io.log(line);
  }
};
