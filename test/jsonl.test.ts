import { describe, expect, test } from "bun:test";
import { classify, flattenContent, parseLine } from "../src/jsonl.ts";

describe("parseLine", () => {
  test("parses valid JSON object", () => {
    expect(parseLine('{"a":1}')).toEqual({ a: 1 });
  });

  test("returns undefined on malformed JSON", () => {
    expect(parseLine("{not json")).toBeUndefined();
    expect(parseLine("")).toBeUndefined();
  });

  test("distinguishes failure from valid falsy JSON", () => {
    // The bug this guards: failure must be undefined, not null, so a line that
    // legitimately parses to null/0/false is not mistaken for a parse error.
    expect(parseLine("null")).toBeNull();
    expect(parseLine("0")).toBe(0);
    expect(parseLine("false")).toBe(false);
  });
});

describe("flattenContent", () => {
  test("passes a string through unchanged", () => {
    expect(flattenContent("hello world")).toBe("hello world");
  });

  test("concatenates text and thinking blocks", () => {
    expect(
      flattenContent([
        { type: "text", text: "answer" },
        { type: "thinking", thinking: "reasoning" },
      ]),
    ).toBe("answer\nreasoning");
  });

  test("tags tool_use with name and compact JSON input", () => {
    const out = flattenContent([{ type: "tool_use", name: "Bash", input: { command: "ls" } }]);
    expect(out).toBe('[tool_use:Bash] {"command":"ls"}');
  });

  test("tags tool_result and recurses into nested content", () => {
    const out = flattenContent([
      { type: "tool_result", content: [{ type: "text", text: "file.ts" }] },
    ]);
    expect(out).toBe("[tool_result] file.ts");
  });

  test("flags an error tool_result", () => {
    const out = flattenContent([{ type: "tool_result", is_error: true, content: "boom" }]);
    expect(out).toBe("[tool_result:error] boom");
  });

  test("caps a large tool_result, keeping the head plus a marker", () => {
    const big = "x".repeat(5000);
    const out = flattenContent([{ type: "tool_result", content: big }]);
    // head is "[tool_result] " (14) + first chars up to the 1000 cap, then a marker.
    expect(out.startsWith("[tool_result] xxxx")).toBe(true);
    expect(out).toContain("chars truncated]");
    expect(out.indexOf(" [+")).toBe(1000);
  });

  test("caps a large tool_use input the same way", () => {
    const out = flattenContent([
      { type: "tool_use", name: "Write", input: { content: "y".repeat(5000) } },
    ]);
    expect(out.startsWith('[tool_use:Write] {"content":"yyyy')).toBe(true);
    expect(out).toContain("chars truncated]");
  });

  test("does not cap an error tool_result", () => {
    const out = flattenContent([
      { type: "tool_result", is_error: true, content: "z".repeat(5000) },
    ]);
    expect(out).toBe(`[tool_result:error] ${"z".repeat(5000)}`);
    expect(out).not.toContain("chars truncated]");
  });

  test("leaves a small tool block untouched", () => {
    const out = flattenContent([{ type: "tool_result", content: "short output" }]);
    expect(out).toBe("[tool_result] short output");
  });

  test("renders images as a placeholder", () => {
    expect(flattenContent([{ type: "image", source: {} }])).toBe("[image]");
  });

  test("skips an unrecognized block type, keeping the rest", () => {
    const out = flattenContent([
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "kept" },
    ]);
    expect(out).toBe("kept");
  });

  test("returns empty string for null / non-array content", () => {
    expect(flattenContent(null)).toBe("");
    expect(flattenContent(undefined)).toBe("");
    expect(flattenContent(42)).toBe("");
  });
});

describe("classify", () => {
  test("keeps a user message", () => {
    const result = classify({
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: "S",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "hi" },
    });
    expect(result).toMatchObject({ kind: "message", uuid: "u1", role: "user", text: "hi" });
  });

  test("captures isSidechain", () => {
    const r = classify({
      type: "assistant",
      uuid: "a1",
      isSidechain: true,
      message: { content: "x" },
    });
    expect(r).toMatchObject({ kind: "message", isSidechain: true });
    const r2 = classify({ type: "assistant", uuid: "a2", message: { content: "x" } });
    expect(r2).toMatchObject({ kind: "message", isSidechain: false });
  });

  test("drops a user/assistant event with no uuid or no message", () => {
    expect(classify({ type: "user", message: { content: "x" } })).toEqual({ kind: "skip" });
    expect(classify({ type: "assistant", uuid: "a1" })).toEqual({ kind: "skip" });
  });

  test("classifies a message with every optional field missing as nulls + isSidechain false", () => {
    // The tolerant default: only type, uuid, and message are required; the rest
    // default to null (parentUuid, sessionId, ts, cwd, gitBranch) or false (sidechain).
    expect(classify({ type: "user", uuid: "u1", message: { content: "hi" } })).toEqual({
      kind: "message",
      uuid: "u1",
      parentUuid: null,
      sessionId: null,
      role: "user",
      text: "hi",
      ts: null,
      cwd: null,
      gitBranch: null,
      isSidechain: false,
    });
  });

  test("keeps the message when an optional field has an unexpected type, defaulting that field", () => {
    // Only type/uuid/message are load-bearing. If a future log format changes an
    // optional scalar's type, the turn is still archived (the bad field defaults),
    // never dropped: skip the unknown, default the bad, never lose a conversation turn.
    expect(
      classify({
        type: "user",
        uuid: "u1",
        message: { content: "still archived" },
        timestamp: 1_700_000_000, // number, not the usual ISO string
        isSidechain: "yes", // string, not boolean
        parentUuid: 42, // number, not a uuid string
      }),
    ).toEqual({
      kind: "message",
      uuid: "u1",
      parentUuid: null,
      sessionId: null,
      role: "user",
      text: "still archived",
      ts: null,
      cwd: null,
      gitBranch: null,
      isSidechain: false,
    });
  });

  test("skips an unknown event type so an evolving log format never crashes indexing", () => {
    expect(classify({ type: "tool-call-record", uuid: "x1", message: { content: "x" } })).toEqual({
      kind: "skip",
    });
    expect(classify({ type: "x-future-event" })).toEqual({ kind: "skip" });
  });

  test("title precedence: custom (3) > ai (2) > summary (1)", () => {
    expect(classify({ type: "custom-title", customTitle: "C", sessionId: "S" })).toMatchObject({
      kind: "title",
      title: "C",
      priority: 3,
    });
    expect(classify({ type: "ai-title", aiTitle: "A" })).toMatchObject({
      kind: "title",
      priority: 2,
    });
    expect(classify({ type: "summary", summary: "Su" })).toMatchObject({
      kind: "title",
      priority: 1,
    });
  });

  test("drops non-message bookkeeping events that may reuse UUIDs", () => {
    // file-history-snapshot etc. reuse other messages' UUIDs; they must never
    // become messages or they cause false dedup collisions.
    expect(classify({ type: "file-history-snapshot", uuid: "u1" })).toEqual({ kind: "skip" });
    expect(classify({ type: "system", uuid: "s1", content: "x" })).toEqual({ kind: "skip" });
    expect(classify({ type: "attachment", uuid: "x1" })).toEqual({ kind: "skip" });
  });

  test("skips a non-object", () => {
    expect(classify(null)).toEqual({ kind: "skip" });
    expect(classify("string")).toEqual({ kind: "skip" });
  });
});
