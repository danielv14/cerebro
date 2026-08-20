import { type DryRunResult, dryRunIndex, type IndexResult, runIndex } from "../indexer.ts";
import { humanBytes } from "../render.ts";
import { flag, type OptionTable } from "./args.ts";
import { defineCommand } from "./command.ts";

// `index`: the one-line result of a real run.
export const indexResult = (result: IndexResult): string[] => [
  `Indexed ${result.newMessages} new message(s) ` +
    `(${result.filesIndexed}/${result.filesScanned} files touched).`,
];

// `index --rebuild`: like indexResult but states what a rebuild actually did:
// texts of on-disk messages were re-flattened in place, deleted sources kept.
export const rebuildResult = (result: IndexResult): string[] => [
  `Rebuilt from disk: ${result.newMessages} net-new message(s), stored texts re-flattened ` +
    `(${result.filesIndexed}/${result.filesScanned} files read; messages from deleted sources kept).`,
];

// `index --dry-run`: what a real run would do, writing nothing. Three shapes: a
// --full re-read, an up-to-date archive with nothing to do, or a normal incremental
// plan. All end with the same "nothing written" line.
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

// The `index` command: incremental by default; --full/--rebuild re-read everything
// (dedup keeps it idempotent); --dry-run reports the plan without writing. Named
// index-cmd.ts, not index.ts, so the file never doubles as a directory index import.
export const indexCommand = defineCommand({
  options,
  run: ({ db, args, progress }) => {
    // A rebuild reads exactly what --full reads; the dry run reports that plan.
    if (args["dry-run"]) return { lines: dryRunReport(dryRunIndex(db, args.full || args.rebuild)) };
    // Skip messages stream through the injected sink as they happen: a skipped
    // file is worth a line even when the rest of the run succeeds.
    if (args.rebuild)
      return { lines: rebuildResult(runIndex(db, { rebuild: true, onSkip: progress })) };
    return { lines: indexResult(runIndex(db, { full: args.full, onSkip: progress })) };
  },
});
