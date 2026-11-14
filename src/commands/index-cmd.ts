import { type DryRunResult, dryRunIndex, type IndexResult, runIndex } from "../indexer.ts";
import { humanBytes } from "../render.ts";
import type { IndexMode } from "../scan.ts";
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

const note = (files: number, label: string): string => (files > 0 ? `, ${files} ${label}` : "");

const pendingNote = (plan: DryRunResult): string => note(plan.pendingFiles, "empty or mid-write");

const leftOut = (plan: DryRunResult): string =>
  note(plan.skippedFiles, "not indexable") + pendingNote(plan);

export const dryRunReport = (plan: DryRunResult): string[] => {
  if (plan.filesScanned === 0) return ["Dry run: no session files found. Nothing written."];

  const lines: string[] = [];
  const modeFlag = plan.mode === "incremental" ? "" : ` --${plan.mode}`;
  if (plan.mode !== "incremental") {
    const files =
      plan.filesToRead === plan.filesScanned
        ? `all ${plan.filesToRead} file(s)`
        : `${plan.filesToRead} of ${plan.filesScanned} file(s)${leftOut(plan)}`;
    lines.push(`Dry run (--${plan.mode}): would re-index ${files}.`);
    lines.push(`  Candidate messages: ${plan.candidateMessages} (before UUID dedup)`);
    lines.push(`  Bytes to index:     ${humanBytes(plan.newBytes)}`);
    lines.push("  On an up-to-date archive dedup collapses this to ~0 net-new messages.");
  } else if (plan.filesToRead === 0) {
    lines.push(
      `Dry run: nothing to index. ${plan.unchangedFiles}/${plan.filesScanned} files unchanged${leftOut(plan)}.`,
    );
  } else {
    lines.push("Dry run. Would index:");
    lines.push(`  New messages:  ${plan.candidateMessages}`);
    lines.push(`  New bytes:     ${humanBytes(plan.newBytes)}`);
    lines.push(
      `  Files:         ${plan.newFiles} new, ${plan.grownFiles} grown, ` +
        `${plan.truncatedFiles} truncated, ${plan.unchangedFiles} unchanged, ` +
        `${plan.skippedFiles} not indexable${pendingNote(plan)}`,
    );
  }
  lines.push(`\nNothing written. Run \`cerebro index${modeFlag}\` to apply.`);
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
  run: ({ db, args, warn, resolveGit, adapters }) => {
    const mode: IndexMode = args.rebuild ? "rebuild" : args.full ? "full" : "incremental";
    if (args["dry-run"]) return { lines: dryRunReport(dryRunIndex(db, adapters, mode)) };
    const result = runIndex(db, { adapters, mode, resolveGit, onSkip: warn });
    return { lines: mode === "rebuild" ? rebuildResult(result) : indexResult(result) };
  },
});
