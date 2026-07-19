import { describe, expect, test } from "bun:test";
import { showFull, showOutline, showRange } from "../../src/commands/show.ts";

describe("showOutline", () => {
  test("header, numbered one-line-per-message digest with subagent marker, footer", () => {
    const lines = showOutline("0123456789abcdef", [
      {
        role: "user",
        ts: "2026-01-15T08:00:00Z",
        text: "hello there",
        session_id: "S",
        is_sidechain: 0,
      },
      {
        role: "assistant",
        ts: "2026-01-15T08:00:00Z",
        text: "general kenobi",
        session_id: "S",
        is_sidechain: 1,
      },
    ]);
    expect(lines).toEqual([
      "Thread 01234567  2 message(s)\n",
      "  1. user      2026-01-15 09:00  hello there",
      "  2. assistant 2026-01-15 09:00  [subagent] general kenobi",
      "\nFull transcript: cerebro show <id> --full",
    ]);
  });
});

describe("showFull", () => {
  test("header, then each message verbatim under a separator with blank lines", () => {
    const lines = showFull("0123456789abcdef", [
      {
        role: "user",
        ts: "2026-01-15T08:00:00Z",
        text: "hello there",
        session_id: "S",
        is_sidechain: 0,
      },
      {
        role: "assistant",
        ts: "2026-01-15T08:00:00Z",
        text: "general kenobi",
        session_id: "S",
        is_sidechain: 1,
      },
    ]);
    expect(lines).toEqual([
      "Thread 01234567  2 message(s)\n",
      "──── user · 2026-01-15 09:00 ────",
      "hello there",
      "",
      "──── assistant · subagent · 2026-01-15 09:00 ────",
      "general kenobi",
      "",
    ]);
  });
});

describe("showRange", () => {
  test("renders a numbered verbatim slice with the range header", () => {
    const lines = showRange(
      "0123456789abcdef",
      [
        {
          role: "user",
          ts: "2026-01-15T08:00:00Z",
          text: "second message",
          session_id: "S",
          is_sidechain: 0,
        },
        {
          role: "assistant",
          ts: "2026-01-15T08:01:00Z",
          text: "third message",
          session_id: "S",
          is_sidechain: 1,
        },
      ],
      { from: 2, total: 10 },
    );
    expect(lines).toEqual([
      "Thread 01234567  showing 2..3 of 10 message(s)\n",
      "──── #2 user · 2026-01-15 09:00 ────",
      "second message",
      "",
      "──── #3 assistant · subagent · 2026-01-15 09:01 ────",
      "third message",
      "",
    ]);
  });
});
