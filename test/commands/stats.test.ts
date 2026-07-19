import { describe, expect, test } from "bun:test";
import { statsReport } from "../../src/commands/stats.ts";

describe("statsReport", () => {
  const base = {
    threads: 4,
    sessions: 6,
    messages: 120,
    deletedSources: 1,
    firstTs: "2026-01-15T08:00:00Z",
    lastTs: "2026-07-15T08:00:00Z",
    summarizedThreads: 3,
    topProjects: [
      { project_path: "/Users/foo/cerebro", threads: 3 },
      { project_path: "/Users/foo/api", threads: 1 },
    ],
  };

  test("renders counts, coverage, span, size, and top projects", () => {
    expect(statsReport(base, { dbBytes: 5 * 1024 * 1024, staleThreads: 2 })).toEqual([
      "Threads:          4 (3 summarized, 2 stale)",
      "Sessions:         6",
      "Messages:         120",
      "Deleted sources:  1",
      "Span:             2026-01-15 .. 2026-07-15",
      "Database size:    5.0 MB",
      "Top projects:     cerebro (3), api (1)",
    ]);
  });

  test("omits the size line without a measurable file and projects when empty", () => {
    const lines = statsReport({ ...base, topProjects: [] }, { dbBytes: null, staleThreads: 0 });
    expect(lines.some((l) => l.startsWith("Database size"))).toBe(false);
    expect(lines.some((l) => l.startsWith("Top projects"))).toBe(false);
  });
});
