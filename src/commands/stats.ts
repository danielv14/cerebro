import { dbFileSize } from "../db.ts";
import { type SummaryCoverage, summaryCoverage } from "../digest/index.ts";
import { type Stats, stats } from "../query.ts";
import { humanBytes, projectName, shortDate } from "../render.ts";
import { flag, type OptionTable } from "./args.ts";
import { defineCommand } from "./command.ts";

// `stats` output: the archive counts, labels left-aligned to a shared column.
// `extras` carries what the query layer cannot know: the database file size
// (measured on the path by the command; null for :memory: or a missing file) and
// the summary coverage, which the digest layer owns because it depends on the
// prompt version.
export const statsReport = (
  s: Stats,
  extras: { dbBytes: number | null; coverage: SummaryCoverage },
): string[] => {
  const lines = [
    `Threads:          ${s.threads} (${extras.coverage.summarized} summarized, ${extras.coverage.stale} stale)`,
    `Sessions:         ${s.sessions}`,
    `Messages:         ${s.messages}`,
    `Deleted sources:  ${s.deletedSources}`,
    `Span:             ${shortDate(s.firstTs)} .. ${shortDate(s.lastTs)}`,
  ];
  if (extras.dbBytes !== null) lines.push(`Database size:    ${humanBytes(extras.dbBytes)}`);
  if (s.topProjects.length > 0) {
    lines.push(
      `Top projects:     ${s.topProjects
        .map((p) => `${projectName(p.project_path)} (${p.threads})`)
        .join(", ")}`,
    );
  }
  return lines;
};

const options = { json: flag() } satisfies OptionTable;

// The `stats` command: archive counts plus the database file size and the digest
// staleness count.
export const statsCommand = defineCommand({
  options,
  run: ({ db, dbPath }) => {
    // The file size lives outside the query layer (and is meaningless for the
    // in-memory databases tests use); the coverage numbers are the digest layer's,
    // the same reader doctor's coverage check calls.
    const dbBytes = dbFileSize(dbPath);
    const coverage = summaryCoverage(db);
    const counts = stats(db);
    return {
      json: {
        ...counts,
        dbBytes,
        summarizedThreads: coverage.summarized,
        staleThreads: coverage.stale,
      },
      lines: statsReport(counts, { dbBytes, coverage }),
    };
  },
});
