import { runBackup } from "../backup.ts";
import { humanBytes } from "../render.ts";
import { type OptionTable, positiveInt, text } from "./args.ts";
import { defineCommand } from "./command.ts";

export const backupReport = (result: {
  path: string;
  bytes: number;
  pruned: string[];
}): string[] => {
  const lines = [`Backup written: ${result.path} (${humanBytes(result.bytes)})`];
  for (const pruned of result.pruned) lines.push(`Pruned old backup: ${pruned}`);
  return lines;
};

const options = {
  to: text(),
  keep: positiveInt(),
} satisfies OptionTable;

export const backupCommand = defineCommand({
  options,
  run: ({ db, args, dbPath }) => ({
    lines: backupReport(runBackup(db, dbPath, { to: args.to, keep: args.keep })),
  }),
});
