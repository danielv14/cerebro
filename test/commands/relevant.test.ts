import { describe, expect, test } from "bun:test";
import {
  relevantBlock,
  relevantContextIntro,
  relevantFooter,
} from "../../src/commands/relevant.ts";

// ── Agent-facing context block ────────────────────────────────────────────────
// The bytes the UserPromptSubmit hook injects into the model, so the exact string
// (and especially the load-bearing guardrail + recall clauses) is pinned.
// relevantBlock composes these; they are also pinned directly here as the external
// contract.

describe("relevant context block", () => {
  test("intro carries the ignore-if-unrelated guardrail", () => {
    expect(relevantContextIntro()).toBe(
      "Possibly relevant past Claude Code sessions (from the cerebro archive, matched " +
        "against this prompt). Background only; ignore any that do not actually relate.",
    );
  });

  test("footer carries the recall instructions (shared by both branches)", () => {
    expect(relevantFooter()).toBe(
      "\nTo recall one: cerebro show <id> (add --full for the transcript), " +
        'or cerebro search "<terms>".',
    );
  });
});

describe("relevantBlock", () => {
  test("context branch: agent intro, opened + summary snippet, shared footer", () => {
    const lines = relevantBlock(
      [
        {
          id: "0123456789abcdef",
          last_ts: "2026-01-15T08:00:00Z",
          project_path: "/Users/foo/cerebro",
          title: "Some thread",
          snippet: "matched bit",
          opening: "the opening",
          fromSummary: true,
        },
      ],
      { context: true },
    );
    expect(lines).toEqual([
      relevantContextIntro(),
      "  01234567  2026-01-15  cerebro  Some thread",
      "      opened: the opening",
      "      summary: matched bit",
      relevantFooter(),
    ]);
  });

  test("plain branch: human intro, (unknown)/(untitled), match-tier snippet", () => {
    const lines = relevantBlock(
      [
        {
          id: "0123456789abcdef",
          last_ts: "2026-01-15T08:00:00Z",
          project_path: null,
          title: null,
          snippet: "matched bit",
          opening: null,
          fromSummary: false,
        },
      ],
      { context: false },
    );
    expect(lines).toEqual([
      "Related past sessions:",
      "  01234567  2026-01-15  (unknown)  (untitled)",
      "      match:  matched bit",
      relevantFooter(),
    ]);
  });
});
