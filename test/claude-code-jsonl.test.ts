import { describe, expect, test } from "bun:test";
import { parseLine } from "../src/sources/adapter.ts";
import { classify, describeSkipped, flattenContent } from "../src/sources/claude-code-jsonl.ts";

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
    expect(classify({ type: "user", message: { content: "x" } })).toMatchObject({ kind: "skip" });
    expect(classify({ type: "assistant", uuid: "a1" })).toMatchObject({ kind: "skip" });
  });

  test("classifies a message with every optional field missing as nulls + isSidechain false", () => {
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
      model: null,
    });
  });

  test("captures the recorded model on an assistant turn, null when absent", () => {
    expect(
      classify({
        type: "assistant",
        uuid: "a1",
        message: { content: "x", model: "claude-sonnet-4-6" },
      }),
    ).toMatchObject({ kind: "message", model: "claude-sonnet-4-6" });
    expect(
      classify({ type: "assistant", uuid: "a2", message: { content: "x", model: 42 } }),
    ).toMatchObject({ kind: "message", model: null });
    // "<synthetic>" marks an interrupted/API-error turn no model served.
    expect(
      classify({ type: "assistant", uuid: "a3", message: { content: "x", model: "<synthetic>" } }),
    ).toMatchObject({ kind: "message", model: null });
  });

  test("keeps the message when an optional field has an unexpected type, defaulting that field", () => {
    expect(
      classify({
        type: "user",
        uuid: "u1",
        message: { content: "still archived" },
        timestamp: 1_700_000_000,
        isSidechain: "yes",
        parentUuid: 42,
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
      model: null,
    });
  });

  test("skips an unknown event type so an evolving log format never crashes indexing", () => {
    expect(
      classify({ type: "tool-call-record", uuid: "x1", message: { content: "x" } }),
    ).toMatchObject({ kind: "skip" });
    expect(classify({ type: "x-future-event" })).toMatchObject({ kind: "skip" });
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
    expect(classify({ type: "file-history-snapshot", uuid: "u1" })).toMatchObject({ kind: "skip" });
    expect(classify({ type: "system", uuid: "s1", content: "x" })).toMatchObject({ kind: "skip" });
    expect(classify({ type: "attachment", uuid: "x1" })).toMatchObject({ kind: "skip" });
  });

  test("keeps a message the user queued while the agent was busy, in both prompt shapes", () => {
    const queued = (prompt: unknown) =>
      classify({
        type: "attachment",
        uuid: "q1",
        sessionId: "S",
        timestamp: "2026-09-29T10:41:03.812Z",
        isSidechain: false,
        attachment: { type: "queued_command", commandMode: "prompt", prompt },
      });
    const expected = {
      kind: "message",
      uuid: "q1",
      sessionId: "S",
      role: "user",
      text: "run npm uninstall first",
      ts: "2026-09-29T10:41:03.812Z",
      model: null,
    };
    expect(queued("run npm uninstall first")).toMatchObject(expected);
    expect(queued([{ type: "text", text: "run npm uninstall first" }])).toMatchObject(expected);
    expect(
      queued([{ type: "image" }, { type: "text", text: "run npm uninstall first" }]),
    ).toMatchObject({ ...expected, text: "[image]\nrun npm uninstall first" });
  });

  test("skips queued commands that are not user prompts", () => {
    expect(
      classify({
        type: "attachment",
        uuid: "q2",
        attachment: {
          type: "queued_command",
          commandMode: "task-notification",
          prompt: "<task-notification>done</task-notification>",
        },
      }),
    ).toMatchObject({ kind: "skip" });
    expect(
      classify({
        type: "attachment",
        uuid: "q3",
        isSidechain: true,
        attachment: {
          type: "queued_command",
          prompt: "Instruction from the coordinator",
          origin: { kind: "coordinator" },
        },
      }),
    ).toMatchObject({ kind: "skip" });
  });

  test("names a skipped line's kind by its type, refined by the field that tells variants apart", () => {
    const kindOf = (raw: unknown) => {
      expect(classify(raw).kind).toBe("skip");
      return describeSkipped(raw).lineKind;
    };
    expect(kindOf({ type: "file-history-snapshot", uuid: "u1" })).toBe("file-history-snapshot");
    expect(kindOf({ type: "system", subtype: "turn_duration" })).toBe("system:turn_duration");
    expect(kindOf({ type: "system" })).toBe("system");
    expect(kindOf({ type: "attachment", attachment: { type: "date" } })).toBe("attachment:date");
    expect(
      kindOf({
        type: "attachment",
        attachment: { type: "queued_command", commandMode: "task-notification", prompt: "x" },
      }),
    ).toBe("attachment:queued_command:task-notification");
    expect(
      kindOf({ type: "attachment", attachment: { type: "queued_command", prompt: "x" } }),
    ).toBe("attachment:queued_command");
    expect(kindOf({ type: "attachment", attachment: "not an object" })).toBe("attachment");
    expect(kindOf({ type: "user", message: { content: "no uuid" } })).toBe("user");
    expect(kindOf({ uuid: "u1" })).toBe("(no type)");
    expect(kindOf(null)).toBe("(not an object)");
  });

  test("skips a non-object", () => {
    expect(classify(null)).toMatchObject({ kind: "skip" });
    expect(classify("string")).toMatchObject({ kind: "skip" });
  });
});
