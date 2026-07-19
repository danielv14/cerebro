import { describe, expect, test } from "bun:test";
import { searchListing } from "../../src/commands/search.ts";

describe("searchListing", () => {
  test("renders a header + snippet line per hit, then the count footer", () => {
    const lines = searchListing([
      {
        id: 1,
        session_id: "0123456789abcdef",
        ts: "2026-07-15T08:00:00Z",
        role: "user",
        project_path: "/Users/foo/cerebro",
        title: null,
        snippet: "a matched snippet",
        ordinal: 1,
      },
    ]);
    expect(lines).toEqual([
      "01234567  2026-07-15 10:00  user       cerebro",
      "    #1  a matched snippet",
      "\n1 hit(s), best per thread (--all for every message). " +
        "Open one with: cerebro show <id> (jump to a hit: --range <n>)",
    ]);
  });

  test("--all restores the plain per-message footer", () => {
    const lines = searchListing(
      [
        {
          id: 1,
          session_id: "0123456789abcdef",
          ts: "2026-07-15T08:00:00Z",
          role: "user",
          project_path: "/Users/foo/cerebro",
          title: null,
          snippet: "a matched snippet",
          ordinal: 3,
        },
      ],
      { all: true },
    );
    expect(lines[1]).toBe("    #3  a matched snippet");
    expect(lines[2]).toBe(
      "\n1 hit(s). Open one with: cerebro show <id> (jump to a hit: --range <n>)",
    );
  });

  test("truncates the snippet at 160 columns", () => {
    const lines = searchListing([
      {
        id: 1,
        session_id: "0123456789abcdef",
        ts: "2026-07-15T08:00:00Z",
        role: "user",
        project_path: "/Users/foo/cerebro",
        title: null,
        snippet: "s".repeat(200),
        ordinal: 1,
      },
    ]);
    expect(lines[1]).toBe(`    #1  ${"s".repeat(159)}…`);
  });

  test("appends the thread title to the header line when present, truncated at 60", () => {
    const lines = searchListing([
      {
        id: 1,
        session_id: "0123456789abcdef",
        ts: "2026-07-15T08:00:00Z",
        role: "assistant",
        project_path: "/Users/foo/cerebro",
        title: "Fix flaky auth test",
        snippet: "a snippet",
        ordinal: 1,
      },
    ]);
    expect(lines[0]).toBe("01234567  2026-07-15 10:00  assistant  cerebro  Fix flaky auth test");
    const long = searchListing([
      {
        id: 1,
        session_id: "0123456789abcdef",
        ts: "2026-07-15T08:00:00Z",
        role: "user",
        project_path: "/Users/foo/cerebro",
        title: "t".repeat(80),
        snippet: "a snippet",
        ordinal: 1,
      },
    ]);
    expect(long[0]).toBe(`01234567  2026-07-15 10:00  user       cerebro  ${"t".repeat(59)}…`);
  });
});
