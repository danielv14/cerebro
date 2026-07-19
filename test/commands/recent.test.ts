import { describe, expect, test } from "bun:test";
import { recentBlock, recentContextFooter, recentContextIntro } from "../../src/commands/recent.ts";

// ── Agent-facing context block ────────────────────────────────────────────────
// The bytes the SessionStart hook injects into the model, so the exact string (and
// especially the load-bearing guardrail + recall clauses) is pinned. recentBlock
// composes these; they are also pinned directly here as the external contract.

describe("recent context block", () => {
  test("intro names the repo and carries the ignore-if-unrelated guardrail", () => {
    expect(recentContextIntro("cerebro")).toBe(
      "Recent Claude Code sessions in this repo (cerebro), from the cerebro archive. " +
        "Background only; ignore if unrelated to the current task.",
    );
  });

  test("footer carries the recall instructions", () => {
    expect(recentContextFooter()).toBe(
      "\nIf the request overlaps with any of these, recall that work instead of starting over:\n" +
        "  cerebro show <id>          thread outline (add --full for the transcript)\n" +
        '  cerebro search "<terms>"   full-text search across all past sessions',
    );
  });
});

describe("recentBlock", () => {
  test("plain branch: human header, msg count shown, opened line, plain footer", () => {
    const lines = recentBlock(
      [
        {
          thread: {
            id: "0123456789abcdef",
            last_ts: "2026-01-15T08:00:00Z",
            first_ts: null,
            msgs: 7,
            sessions_in_thread: 1,
            project_path: "/Users/foo/cerebro",
            title: "Hello world",
            body_available: 1,
          },
          opening: "do the thing",
        },
      ],
      { repoPath: "/Users/foo/cerebro", days: 14, context: false },
    );
    expect(lines).toEqual([
      "Recent sessions in cerebro (last 14 days):",
      "  01234567  2026-01-15     7 msgs  Hello world",
      "      opened: do the thing",
      '\nPull prior context: cerebro show <id>  |  cerebro search "<terms>"',
    ]);
  });

  test("context branch: agent block, msg count hidden, untitled, no opening line", () => {
    const lines = recentBlock(
      [
        {
          thread: {
            id: "0123456789abcdef",
            last_ts: "2026-01-15T08:00:00Z",
            first_ts: null,
            msgs: 7,
            sessions_in_thread: 1,
            project_path: "/repo",
            title: null,
            body_available: 1,
          },
          opening: null,
        },
      ],
      { repoPath: "/repo", days: 14, context: true },
    );
    expect(lines).toEqual([
      recentContextIntro("repo"),
      "  01234567  2026-01-15  (untitled)",
      recentContextFooter(),
    ]);
  });

  test("truncates the title at 90 columns", () => {
    const lines = recentBlock(
      [
        {
          thread: {
            id: "0123456789abcdef",
            last_ts: "2026-01-15T08:00:00Z",
            first_ts: null,
            msgs: 1,
            sessions_in_thread: 1,
            project_path: "/repo",
            title: "x".repeat(100),
            body_available: 1,
          },
          opening: null,
        },
      ],
      { repoPath: "/repo", days: 14, context: true },
    );
    expect(lines[1]).toBe(`  01234567  2026-01-15  ${"x".repeat(89)}…`);
  });
});
