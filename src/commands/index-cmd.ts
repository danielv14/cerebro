import { type DryRunResult, dryRunIndex, type IndexResult, runIndex } from "../indexer.ts";
import { humanBytes } from "../render.ts";
import { flag, type OptionTable } from "./args.ts";
import { defineCommand } from "./command.ts";

export const indexResult = (result: IndexResult): string[] => [
  `Indexed ${result.newMessages} new message(s) ` +
    `(${result.filesIndexed}/${result.filesScanned} files touched).`,
];

export const rebuildResult = (result: IndexResult): string[] => [
  `Rebuilt from disk: ${result.newMessages} net-new message(s), stored texts re-flattened ` +
    `(${result.filesIndexed}/${result.filesScanned} files read; messages from deleted sources kept).`,
];

export const dryRunReport = (plan: DryRunResult): string[] => {
  const lines: string[] = [];
  if (plan.full) {
    lines.push(`Dry run (--full): would re-read all ${plan.filesToRead} file(s).`);
    lines.push(`  Candidate messages: ${plan.candidateMessages} (before UUID dedup)`);
    lines.push(`  Bytes to read:      ${humanBytes(plan.newBytes)}`);
    lines.push("  On an up-to-date archive dedup collapses this to ~0 net-new messages.");
  } else if (plan.filesToRead === 0) {
    lines.push(
      `Dry run: nothing to index. ${plan.unchangedFiles}/${plan.filesScanned} files unchanged.`,
    );
  } else {
    lines.push("Dry run. Would index:");
    lines.push(`  New messages:  ${plan.candidateMessages}`);
    lines.push(`  New bytes:     ${humanBytes(plan.newBytes)}`);
    lines.push(
      `  Files:         ${plan.newFiles} new, ${plan.grownFiles} grown, ` +
        `${plan.truncatedFiles} truncated, ${plan.unchangedFiles} unchanged (skipped)`,
    );
  }
  lines.push("\nNothing written. Run `cerebro index` to apply.");
  return lines;
};

const options = {
  full: flag(),
  rebuild: flag(),
  "dry-run": flag(),
} satisfies OptionTable;

// Named index-cmd.ts, not index.ts, so the file never doubles as a directory
// index import.
export const indexCommand = defineCommand({
  options,
  run: ({ db, args, progress, resolveGit }) => {
    if (args["dry-run"]) return { lines: dryRunReport(dryRunIndex(db, args.full || args.rebuild)) };
    if (args.rebuild)
      return {
        lines: rebuildResult(runIndex(db, { rebuild: true, resolveGit, onSkip: progress })),
      };
    return { lines: indexResult(runIndex(db, { full: args.full, resolveGit, onSkip: progress })) };
  },
});
