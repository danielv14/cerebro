import { describe, expect, test } from "bun:test";
import { sessionsListing } from "../../src/commands/sessions.ts";

describe("sessionsListing", () => {
  test("renders the thread row plus the title on its own line, truncated at 120", () => {
    const lines = sessionsListing([
      {
        id: "0123456789abcdef",
        last_ts: "2026-07-15T08:00:00Z",
        first_ts: null,
        msgs: 42,
        sessions_in_thread: 1,
        project_path: "/Users/foo/cerebro",
        git_branch: null,
        title: "My thread",
        body_available: 1,
      },
    ]);
    expect(lines).toEqual(["01234567  2026-07-15 10:00    42 msgs  cerebro", "    My thread"]);
  });

  test("appends the recorded branch to the project as an @suffix", () => {
    const lines = sessionsListing([
      {
        id: "0123456789abcdef",
        last_ts: "2026-07-15T08:00:00Z",
        first_ts: null,
        msgs: 42,
        sessions_in_thread: 1,
        project_path: "/Users/foo/cerebro",
        git_branch: "feat/branch-filter",
        title: "My thread",
        body_available: 1,
      },
    ]);
    expect(lines[0]).toBe("01234567  2026-07-15 10:00    42 msgs  cerebro @feat/branch-filter");
  });

  test("appends resume and [body deleted] suffixes and falls back to (untitled)", () => {
    const lines = sessionsListing([
      {
        id: "0123456789abcdef",
        last_ts: "2026-07-15T08:00:00Z",
        first_ts: null,
        msgs: 42,
        sessions_in_thread: 3,
        project_path: "/Users/foo/cerebro",
        git_branch: "main",
        title: null,
        body_available: 0,
      },
    ]);
    expect(lines).toEqual([
      "01234567  2026-07-15 10:00    42 msgs  cerebro @main +2 resume(s)  [body deleted]",
      "    (untitled)",
    ]);
  });
});
