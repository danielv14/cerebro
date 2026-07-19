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
        title: "My thread",
        body_available: 1,
      },
    ]);
    expect(lines).toEqual(["01234567  2026-07-15 10:00    42 msgs  cerebro", "    My thread"]);
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
        title: null,
        body_available: 0,
      },
    ]);
    expect(lines).toEqual([
      "01234567  2026-07-15 10:00    42 msgs  cerebro +2 resume(s)  [body deleted]",
      "    (untitled)",
    ]);
  });
});
