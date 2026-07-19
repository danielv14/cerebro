import { describe, expect, test } from "bun:test";
import { dryRunReport, indexResult } from "../../src/commands/index-cmd.ts";

describe("indexResult", () => {
  test("reports new messages and files touched", () => {
    expect(indexResult({ newMessages: 7, filesScanned: 3, filesIndexed: 2 })).toEqual([
      "Indexed 7 new message(s) (2/3 files touched).",
    ]);
  });
});

describe("dryRunReport", () => {
  test("normal incremental plan", () => {
    expect(
      dryRunReport({
        full: false,
        filesScanned: 5,
        filesToRead: 2,
        newFiles: 1,
        grownFiles: 1,
        truncatedFiles: 0,
        unchangedFiles: 3,
        newBytes: 2048,
        candidateMessages: 12,
      }),
    ).toEqual([
      "Dry run. Would index:",
      "  New messages:  12",
      "  New bytes:     2.0 KB",
      "  Files:         1 new, 1 grown, 0 truncated, 3 unchanged (skipped)",
      "\nNothing written. Run `cerebro index` to apply.",
    ]);
  });

  test("nothing to index", () => {
    expect(
      dryRunReport({
        full: false,
        filesScanned: 5,
        filesToRead: 0,
        newFiles: 0,
        grownFiles: 0,
        truncatedFiles: 0,
        unchangedFiles: 5,
        newBytes: 0,
        candidateMessages: 0,
      }),
    ).toEqual([
      "Dry run: nothing to index. 5/5 files unchanged.",
      "\nNothing written. Run `cerebro index` to apply.",
    ]);
  });

  test("--full re-read", () => {
    expect(
      dryRunReport({
        full: true,
        filesScanned: 5,
        filesToRead: 5,
        newFiles: 0,
        grownFiles: 0,
        truncatedFiles: 0,
        unchangedFiles: 0,
        newBytes: 1024 * 1024,
        candidateMessages: 100,
      }),
    ).toEqual([
      "Dry run (--full): would re-read all 5 file(s).",
      "  Candidate messages: 100 (before UUID dedup)",
      "  Bytes to read:      1.0 MB",
      "  On an up-to-date archive dedup collapses this to ~0 net-new messages.",
      "\nNothing written. Run `cerebro index` to apply.",
    ]);
  });
});
