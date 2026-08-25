import { describe, expect, test } from "bun:test";
import { planFileRead, splitBuffer } from "../src/scan.ts";
import type { SessionFile } from "../src/sources/adapter.ts";

describe("splitBuffer", () => {
  test("empty buffer keeps the cursor", () => {
    expect(splitBuffer(Buffer.from(""), 0)).toEqual({ lines: [], cursor: 0 });
  });

  test("complete newline-terminated lines, cursor at end", () => {
    const buf = Buffer.from('{"a":1}\n{"b":2}\n');
    expect(splitBuffer(buf, 0)).toEqual({ lines: ['{"a":1}', '{"b":2}'], cursor: 16 });
  });

  test("final line without newline that parses is included", () => {
    const buf = Buffer.from('{"a":1}\n{"b":2}');
    expect(splitBuffer(buf, 0)).toEqual({ lines: ['{"a":1}', '{"b":2}'], cursor: 15 });
  });

  test("final line without newline that does NOT parse is held back", () => {
    const buf = Buffer.from('{"a":1}\n{"b":2');
    expect(splitBuffer(buf, 0)).toEqual({ lines: ['{"a":1}'], cursor: 8 });
  });

  test("no newline and unparseable holds everything (mid-write)", () => {
    expect(splitBuffer(Buffer.from('{"b":2'), 0)).toEqual({ lines: [], cursor: 0 });
  });

  test("no newline but parseable is taken", () => {
    expect(splitBuffer(Buffer.from('{"b":2}'), 0)).toEqual({ lines: ['{"b":2}'], cursor: 7 });
  });

  test("a falsy-but-valid JSON tail is included, not mistaken for mid-write", () => {
    const buf = Buffer.from('{"a":1}\n0');
    expect(splitBuffer(buf, 0)).toEqual({ lines: ['{"a":1}', "0"], cursor: 9 });
  });

  test("cursor is relative to the start offset", () => {
    expect(splitBuffer(Buffer.from('{"b":2}\n'), 100)).toEqual({ lines: ['{"b":2}'], cursor: 108 });
  });
});

describe("planFileRead", () => {
  const file = (size: number, mtimeMs = 1000): SessionFile => ({
    path: "/tmp/S.jsonl",
    kind: "session",
    sessionId: "S",
    projectDir: "-repo",
    provider: "claude-code",
    size,
    mtimeMs,
  });

  test("new file (no state) reads from 0", () => {
    expect(planFileRead(null, file(100), false)).toEqual({
      start: 0,
      status: "new",
      shouldRead: true,
    });
  });

  test("grown file (state.bytes < size) reads from the saved cursor", () => {
    const plan = planFileRead({ bytes_indexed: 40, mtime_ms: 1000 }, file(100), false);
    expect(plan).toEqual({ start: 40, status: "grown", shouldRead: true });
  });

  test("truncated file (state.bytes > size) resets start to 0", () => {
    const plan = planFileRead({ bytes_indexed: 200, mtime_ms: 1000 }, file(100), false);
    expect(plan).toEqual({ start: 0, status: "truncated", shouldRead: true });
  });

  test("unchanged file (bytes === size && mtime matches) is not read", () => {
    const plan = planFileRead({ bytes_indexed: 100, mtime_ms: 1000 }, file(100, 1000), false);
    expect(plan).toEqual({ start: 100, status: "unchanged", shouldRead: false });
  });

  test("size matches but mtime differs -> should read (treated as grown)", () => {
    const plan = planFileRead({ bytes_indexed: 100, mtime_ms: 999 }, file(100, 1000), false);
    expect(plan).toEqual({ start: 100, status: "grown", shouldRead: true });
  });

  test("full mode always reads from 0 and never short-circuits as unchanged", () => {
    const plan = planFileRead({ bytes_indexed: 100, mtime_ms: 1000 }, file(100, 1000), true);
    expect(plan).toEqual({ start: 0, status: "grown", shouldRead: true });
    // full with no prior state is reported as "new" (callers ignore status in full)
    expect(planFileRead(null, file(100), true)).toEqual({
      start: 0,
      status: "new",
      shouldRead: true,
    });
  });
});
