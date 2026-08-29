import { dbFileSize } from "../db.ts";
import { type SummaryCoverage, summaryCoverage } from "../digest/index.ts";
import { humanBytes, projectName, shortDate } from "../render.ts";
import { type Stats, stats } from "../stats.ts";
import { flag, type OptionTable } from "./args.ts";
import { defineCommand } from "./command.ts";

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

export const statsCommand = defineCommand({
  options,
  run: ({ db, dbPath }) => {
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
