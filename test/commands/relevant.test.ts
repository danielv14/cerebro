import { describe, expect, test } from "bun:test";
import { relevantBlock } from "../../src/commands/relevant.ts";
import type { RelevantThread } from "../../src/relevance.ts";

const RECALL_FOOTER =
  "\nTo recall one: cerebro show <id> (add --full for the transcript), " +
  'or cerebro search "<terms>".';

const makeThread = (overrides: Partial<RelevantThread> = {}): RelevantThread => ({
  id: "0123456789abcdef",
  last_ts: "2026-01-15T08:00:00Z",
  project_path: "/Users/foo/cerebro",
  provider: "claude-code",
  model: null,
  title: null,
  snippet: "matched bit",
  opening: null,
  fromSummary: false,
  ...overrides,
});

describe("relevantBlock", () => {
  test("renders the opened line and the summary-tier snippet", () => {
    const lines = relevantBlock([
      makeThread({ title: "Some thread", opening: "the opening", fromSummary: true }),
    ]);
    expect(lines).toEqual([
      "Related past sessions:",
      "  01234567  2026-01-15  cerebro  Some thread",
      "      opened: the opening",
      "      summary: matched bit",
      RECALL_FOOTER,
    ]);
  });

  test("falls back to (unknown) and (untitled) on the match tier", () => {
    const lines = relevantBlock([makeThread({ project_path: null })]);
    expect(lines).toEqual([
      "Related past sessions:",
      "  01234567  2026-01-15  (unknown)  (untitled)",
      "      match:  matched bit",
      RECALL_FOOTER,
    ]);
  });
});
