import { describe, expect, test } from "bun:test";
import { DIGEST_PROMPT_SIGNATURE } from "../src/digest/signature.ts";
import { fileVerdict, planFileRead, type ScannedFile, splitBuffer } from "../src/scan.ts";
import type { SessionFile } from "../src/sources/adapter.ts";
import { classifyLines } from "../src/sources/claude-code-jsonl.ts";
import { userMsg } from "./fixtures.ts";

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

  test("a digest-flagged file is skipped, not merely unchanged", () => {
    // Without the flag this shape reads as "grown": bytes_indexed is short of the
    // file size, so the digest flag is what overrides it.
    const grown = planFileRead(
      { bytes_indexed: 40, mtime_ms: 1000, is_digest: 1 },
      file(100),
      false,
    );
    expect(grown).toEqual({ start: 40, status: "skipped", shouldRead: false });
    // Still skipped under --full, so a --full dry run matches the real run, which
    // has cleared its cursors and re-detects the transcript from byte 0.
    expect(
      planFileRead({ bytes_indexed: 40, mtime_ms: 1000, is_digest: 1 }, file(100), true),
    ).toEqual({ start: 40, status: "skipped", shouldRead: false });
  });

  test("new file (no state) reads from 0", () => {
    expect(planFileRead(null, file(100), false)).toEqual({
      start: 0,
      status: "new",
      shouldRead: true,
    });
  });

  test("grown file (state.bytes < size) reads from the saved cursor", () => {
    const plan = planFileRead(
      { bytes_indexed: 40, mtime_ms: 1000, is_digest: 0 },
      file(100),
      false,
    );
    expect(plan).toEqual({ start: 40, status: "grown", shouldRead: true });
  });

  test("truncated file (state.bytes > size) resets start to 0", () => {
    const plan = planFileRead(
      { bytes_indexed: 200, mtime_ms: 1000, is_digest: 0 },
      file(100),
      false,
    );
    expect(plan).toEqual({ start: 0, status: "truncated", shouldRead: true });
  });

  test("unchanged file (bytes === size && mtime matches) is not read", () => {
    const plan = planFileRead(
      { bytes_indexed: 100, mtime_ms: 1000, is_digest: 0 },
      file(100, 1000),
      false,
    );
    expect(plan).toEqual({ start: 100, status: "unchanged", shouldRead: false });
  });

  test("size matches but mtime differs -> should read (treated as grown)", () => {
    const plan = planFileRead(
      { bytes_indexed: 100, mtime_ms: 999, is_digest: 0 },
      file(100, 1000),
      false,
    );
    expect(plan).toEqual({ start: 100, status: "grown", shouldRead: true });
  });

  test("full mode always reads from 0 and never short-circuits as unchanged", () => {
    const plan = planFileRead(
      { bytes_indexed: 100, mtime_ms: 1000, is_digest: 0 },
      file(100, 1000),
      true,
    );
    expect(plan).toEqual({ start: 0, status: "grown", shouldRead: true });
    expect(planFileRead(null, file(100), true)).toEqual({
      start: 0,
      status: "new",
      shouldRead: true,
    });
  });
});

describe("fileVerdict", () => {
  const session: SessionFile = {
    path: "/tmp/S.jsonl",
    kind: "session",
    sessionId: "S",
    projectDir: "-repo",
    provider: "claude-code",
    size: 100,
    mtimeMs: 1000,
  };
  const scanned = (lines: unknown[], start = 0, file = session): ScannedFile => ({
    file,
    plan: { start, status: start === 0 ? "new" : "grown", shouldRead: true },
    lines: lines.map((line) => JSON.stringify(line)),
    cursor: start + (lines.length === 0 ? 0 : 50),
  });

  test("a read with no complete line has nothing new", () => {
    expect(fileVerdict(scanned([]), classifyLines)).toBe("nothing-new");
  });

  test("a transcript opening with the digest prompt is a digest", () => {
    const digest = [userMsg("S", "u1", `${DIGEST_PROMPT_SIGNATURE} ...`)];
    expect(fileVerdict(scanned(digest), classifyLines)).toBe("digest");
  });

  test("the digest check only fires on a top-level read from byte 0", () => {
    const digest = [userMsg("S", "u1", `${DIGEST_PROMPT_SIGNATURE} ...`)];
    expect(fileVerdict(scanned(digest, 40), classifyLines)).toBe("ingest");
    expect(fileVerdict(scanned(digest, 0, { ...session, kind: "subagent" }), classifyLines)).toBe(
      "ingest",
    );
  });

  test("an ordinary transcript is ingested", () => {
    expect(fileVerdict(scanned([userMsg("S", "u1", "hello")]), classifyLines)).toBe("ingest");
  });
});
