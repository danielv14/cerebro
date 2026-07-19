import { runBackup } from "../backup.ts";
import { backupReport } from "../render.ts";
import type { CommandContext } from "./context.ts";

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
