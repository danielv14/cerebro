import { describe, expect, test } from "bun:test";
import { relevantBlock } from "../../src/commands/relevant.ts";

describe("relevantBlock", () => {
  test("opened + summary-tier snippet under the header, recall footer", () => {
    const lines = relevantBlock([
      {
        id: "0123456789abcdef",
        last_ts: "2026-01-15T08:00:00Z",
        project_path: "/Users/foo/cerebro",
        provider: "claude-code",
        model: null,
        title: "Some thread",
        snippet: "matched bit",
        opening: "the opening",
        fromSummary: true,
      },
    ]);
    expect(lines).toEqual([
      "Related past sessions:",
      "  01234567  2026-01-15  cerebro  Some thread",
      "      opened: the opening",
      "      summary: matched bit",
      "\nTo recall one: cerebro show <id> (add --full for the transcript), " +
        'or cerebro search "<terms>".',
    ]);
  });

  test("(unknown)/(untitled) fallbacks and the match tier", () => {
    const lines = relevantBlock([
      {
        id: "0123456789abcdef",
        last_ts: "2026-01-15T08:00:00Z",
        project_path: null,
        provider: "claude-code",
        model: null,
        title: null,
        snippet: "matched bit",
        opening: null,
        fromSummary: false,
      },
    ]);
    expect(lines.slice(0, 3)).toEqual([
      "Related past sessions:",
      "  01234567  2026-01-15  (unknown)  (untitled)",
      "      match:  matched bit",
    ]);
  });
});
