import { describe, expect, test } from "bun:test";
import { recentBlock } from "../../src/commands/recent.ts";
import type { ThreadRow } from "../../src/thread.ts";

const PULL_FOOTER = '\nPull prior context: cerebro show <id>  |  cerebro search "<terms>"';

const makeThread = (overrides: Partial<ThreadRow> = {}): ThreadRow => ({
  id: "0123456789abcdef",
  last_ts: "2026-01-15T08:00:00Z",
  first_ts: null,
  msgs: 7,
  sessions_in_thread: 1,
  project_path: "/repo",
  git_branch: null,
  provider: "claude-code",
  model: null,
  title: null,
  body_available: 1,
  ...overrides,
});

describe("recentBlock", () => {
  test("names the repo and the window, then one row per thread", () => {
    const lines = recentBlock(
      [
        {
          thread: makeThread({ project_path: "/Users/foo/cerebro", title: "Hello world" }),
          opening: "do the thing",
        },
      ],
      { repoPath: "/Users/foo/cerebro", days: 14 },
    );
    expect(lines).toEqual([
      "Recent sessions in cerebro (last 14 days):",
      "  01234567  2026-01-15     7 msgs  Hello world",
      "      opened: do the thing",
      PULL_FOOTER,
    ]);
  });

  test("omits the opened line when the thread has no opening prompt", () => {
    const lines = recentBlock([{ thread: makeThread(), opening: null }], {
      repoPath: "/repo",
      days: 14,
    });
    expect(lines).toEqual([
      "Recent sessions in repo (last 14 days):",
      "  01234567  2026-01-15     7 msgs  (untitled)",
      PULL_FOOTER,
    ]);
  });

  test("truncates the title at 90 columns", () => {
    const lines = recentBlock(
      [{ thread: makeThread({ msgs: 1, title: "x".repeat(100) }), opening: null }],
      { repoPath: "/repo", days: 14 },
    );
    expect(lines[1]).toBe(`  01234567  2026-01-15     1 msgs  ${"x".repeat(89)}…`);
  });
});
