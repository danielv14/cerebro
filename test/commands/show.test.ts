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

  test("caps a long outline at head 50 + tail 50 with an omitted marker (#147)", () => {
    const messages = Array.from({ length: 101 }, (_, i) => ({
      role: "user",
      ts: "2026-01-15T08:00:00Z",
      text: `message ${i + 1}`,
      session_id: "S",
      is_sidechain: 0 as const,
    }));
    const lines = showOutline("0123456789abcdef", messages);
    // header + 50 head + marker + 50 tail + footer
    expect(lines).toHaveLength(1 + 50 + 1 + 50 + 1);
    expect(lines[1]).toBe("  1. user      2026-01-15 09:00  message 1");
    expect(lines[50]).toBe(" 50. user      2026-01-15 09:00  message 50");
    expect(lines[51]).toBe(
      "  … 1 message(s) omitted (#51..#51), open a slice with: cerebro show <id> --range A..B",
    );
    // The tail keeps its true ordinals, matching --range and search's #N.
    expect(lines[52]).toBe(" 52. user      2026-01-15 09:00  message 52");
    expect(lines[101]).toBe("101. user      2026-01-15 09:00  message 101");
    expect(lines[102]).toBe("\nFull transcript: cerebro show <id> --full");
  });

  test("renders exactly 100 messages uncapped, with no marker", () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({
      role: "user",
      ts: "2026-01-15T08:00:00Z",
      text: `message ${i + 1}`,
      session_id: "S",
      is_sidechain: 0 as const,
    }));
    const lines = showOutline("0123456789abcdef", messages);
    expect(lines).toHaveLength(1 + 100 + 1);
    expect(lines.some((line) => line.includes("omitted"))).toBe(false);
  });

  test("renders a thread with no messages as the header plus footer (#83)", () => {
    // A session with no indexed turns is hidden from the thread listings but still
    // resolves by id, so the outline must render empty rather than error.
    expect(showOutline("0123456789abcdef", [])).toEqual([
      "Thread 01234567  0 message(s)\n",
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
