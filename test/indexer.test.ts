import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db.ts";
import { DIGEST_PROMPT } from "../src/digest.ts";
import { dryRunIndex, planFileRead, runIndex, splitBuffer } from "../src/indexer.ts";
import type { SessionFile } from "../src/paths.ts";
import {
  appendRaw,
  assistantMsg,
  makeClaudeDir,
  type TempClaude,
  ts,
  userMsg,
  writeSession,
  writeSubagent,
} from "./fixtures.ts";

const countMessages = (db: Database): number =>
  (db.query("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;

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

describe("runIndex", () => {
  let env: TempClaude;
  let db: Database;

  beforeEach(() => {
    env = makeClaudeDir();
    process.env.CEREBRO_CLAUDE_DIR = env.claudeRoot;
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
    env.cleanup();
  });

  test("cold index stores user/assistant messages and skips bookkeeping", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "first prompt"),
      { type: "file-history-snapshot", uuid: "u1" }, // reuses u1: must not collide
      assistantMsg("S", "a1", "reply", { parentUuid: "u1" }),
      { type: "system", uuid: "sys1", content: "noise" },
    ]);
    const result = runIndex(db);
    expect(result.newMessages).toBe(2);
    expect(countMessages(db)).toBe(2);
  });

  test("re-indexing is idempotent (dedup on UUID)", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "hi"),
      assistantMsg("S", "a1", "yo", { parentUuid: "u1" }),
    ]);
    expect(runIndex(db).newMessages).toBe(2);
    expect(runIndex(db).newMessages).toBe(0);
    expect(countMessages(db)).toBe(2);
  });

  test("incremental index reads only appended bytes", () => {
    const path = writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "one")]);
    expect(runIndex(db).newMessages).toBe(1);
    appendRaw(path, `${JSON.stringify(assistantMsg("S", "a1", "two", { parentUuid: "u1" }))}\n`);
    expect(runIndex(db).newMessages).toBe(1);
    expect(countMessages(db)).toBe(2);
  });

  test("title precedence resolves to the session title", () => {
    writeSession(env.projects, "-repo", "S", [
      { type: "ai-title", aiTitle: "AI title", sessionId: "S" },
      userMsg("S", "u1", "hi"),
      { type: "custom-title", customTitle: "Custom title", sessionId: "S" },
    ]);
    runIndex(db);
    const row = db.query("SELECT title FROM sessions WHERE session_id = 'S'").get() as {
      title: string;
    };
    expect(row.title).toBe("Custom title");
  });

  test("a later lower-priority title event never clobbers a custom title (#41)", () => {
    const path = writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "hi"),
      { type: "custom-title", customTitle: "Custom title", sessionId: "S" },
    ]);
    runIndex(db);
    // Claude Code appends a summary event later; the incremental run only sees it.
    appendRaw(path, `${JSON.stringify({ type: "summary", summary: "auto", sessionId: "S" })}\n`);
    runIndex(db);
    const row = db
      .query("SELECT title, title_priority FROM sessions WHERE session_id='S'")
      .get() as {
      title: string;
      title_priority: number;
    };
    expect(row.title).toBe("Custom title");
    expect(row.title_priority).toBe(3);
  });

  test("a later higher- or equal-priority title event still replaces the title", () => {
    const path = writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "hi"),
      { type: "ai-title", aiTitle: "AI v1", sessionId: "S" },
    ]);
    runIndex(db);
    appendRaw(path, `${JSON.stringify({ type: "ai-title", aiTitle: "AI v2", sessionId: "S" })}\n`);
    runIndex(db);
    let row = db.query("SELECT title FROM sessions WHERE session_id='S'").get() as {
      title: string;
    };
    expect(row.title).toBe("AI v2"); // equal priority: the newer title wins
    appendRaw(
      path,
      `${JSON.stringify({ type: "custom-title", customTitle: "Mine", sessionId: "S" })}\n`,
    );
    runIndex(db);
    row = db.query("SELECT title FROM sessions WHERE session_id='S'").get() as { title: string };
    expect(row.title).toBe("Mine"); // higher priority wins
  });

  test("a standalone session is its own root", () => {
    writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "hi")]);
    runIndex(db);
    const row = db
      .query("SELECT root_session_id, parent_session_id FROM sessions WHERE session_id='S'")
      .get() as { root_session_id: string; parent_session_id: string | null };
    expect(row.root_session_id).toBe("S");
    expect(row.parent_session_id).toBeNull();
  });

  test("a resume folds into the original thread via parentUuid", () => {
    writeSession(env.projects, "-repo", "ORIG", [
      userMsg("ORIG", "u1", "start", { timestamp: ts(0) }),
      assistantMsg("ORIG", "a1", "ok", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    writeSession(env.projects, "-repo", "RESUME", [
      // first message of the resume continues from the original's last message
      userMsg("RESUME", "u2", "continue", { parentUuid: "a1", timestamp: ts(2) }),
    ]);
    runIndex(db);
    const resume = db
      .query("SELECT parent_session_id, root_session_id FROM sessions WHERE session_id='RESUME'")
      .get() as { parent_session_id: string; root_session_id: string };
    expect(resume.parent_session_id).toBe("ORIG");
    expect(resume.root_session_id).toBe("ORIG");
  });

  test("a NULL-ts or sidechain message cannot shadow the resume link (#44)", () => {
    writeSession(env.projects, "-repo", "ORIG", [
      userMsg("ORIG", "u1", "start", { timestamp: ts(0) }),
      assistantMsg("ORIG", "a1", "ok", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    writeSession(env.projects, "-repo", "RESUME", [
      // A tolerated missing-ts message: sorts first in naive ASC ordering.
      userMsg("RESUME", "noise-null-ts", "no ts", { timestamp: undefined, parentUuid: null }),
      userMsg("RESUME", "u2", "continue", { parentUuid: "a1", timestamp: ts(2) }),
    ]);
    // A sidechain turn folded into RESUME, timestamped before its first main turn.
    writeSubagent(env.projects, "-repo", "RESUME", "agent-x", [
      userMsg("RESUME", "sa1", "sub", { isSidechain: true, timestamp: ts(1), parentUuid: null }),
    ]);
    runIndex(db);
    const resume = db
      .query("SELECT parent_session_id, root_session_id FROM sessions WHERE session_id='RESUME'")
      .get() as { parent_session_id: string | null; root_session_id: string };
    expect(resume.parent_session_id).toBe("ORIG");
    expect(resume.root_session_id).toBe("ORIG");
  });

  test("subagent transcripts fold into the parent session", () => {
    writeSession(env.projects, "-repo", "PARENT", [userMsg("PARENT", "u1", "do a task")]);
    writeSubagent(env.projects, "-repo", "PARENT", "agent-xyz", [
      userMsg("PARENT", "sa1", "subagent prompt", { isSidechain: true }),
      assistantMsg("PARENT", "sa2", "subagent reply", { isSidechain: true, parentUuid: "sa1" }),
    ]);
    runIndex(db);
    // All three messages belong to PARENT; the two sidechain turns are flagged.
    const total = (
      db.query("SELECT COUNT(*) AS c FROM messages WHERE session_id='PARENT'").get() as {
        c: number;
      }
    ).c;
    expect(total).toBe(3);
    const sidechain = (
      db
        .query("SELECT COUNT(*) AS c FROM messages WHERE session_id='PARENT' AND is_sidechain=1")
        .get() as { c: number }
    ).c;
    expect(sidechain).toBe(2);
  });

  test("truncated/rotated file is re-read from the start", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "one"),
      assistantMsg("S", "a1", "two", { parentUuid: "u1" }),
    ]);
    runIndex(db);
    // Rewrite shorter with a different message; cursor (> new size) must reset.
    writeSession(env.projects, "-repo", "S", [userMsg("S", "u3", "fresh")]);
    // shrink check relies on the new file being smaller than indexed bytes
    runIndex(db);
    const hasU3 = db.query("SELECT 1 FROM messages WHERE uuid='u3'").get();
    expect(hasU3).not.toBeNull();
  });

  test("--full re-reads everything but dedups to net zero", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "hi"),
      assistantMsg("S", "a1", "yo", { parentUuid: "u1" }),
    ]);
    runIndex(db);
    const before = countMessages(db);
    const result = runIndex(db, true);
    expect(result.newMessages).toBe(0);
    expect(countMessages(db)).toBe(before);
  });

  test("mid-write final line is deferred, then indexed once complete", () => {
    const path = writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "complete")]);
    const a1 = JSON.stringify(assistantMsg("S", "a1", "later", { parentUuid: "u1" }));
    appendRaw(path, a1.slice(0, 25)); // partial JSON, no newline
    runIndex(db);
    expect(countMessages(db)).toBe(1); // only u1
    appendRaw(path, `${a1.slice(25)}\n`); // complete it
    runIndex(db);
    expect(countMessages(db)).toBe(2);
  });

  test("a deleted source file flips body_available, others stay available", () => {
    const pathA = writeSession(env.projects, "-repo-a", "A", [userMsg("A", "ua", "a")]);
    writeSession(env.projects, "-repo-b", "B", [userMsg("B", "ub", "b")]);
    runIndex(db);
    require("node:fs").rmSync(pathA);
    runIndex(db);
    const rows = db
      .query("SELECT session_id, body_available FROM sessions ORDER BY session_id")
      .all() as { session_id: string; body_available: number }[];
    expect(rows.find((r) => r.session_id === "A")?.body_available).toBe(0);
    expect(rows.find((r) => r.session_id === "B")?.body_available).toBe(1);
  });

  test("a digest summarization run is not indexed as a session", () => {
    // cerebro's own `claude -p "$(cerebro digest prompt)"` run: Claude Code records it
    // as a session whose first turn is the digest prompt. It must not enter the archive.
    writeSession(env.projects, "-repo", "DIG", [
      userMsg("DIG", "d1", DIGEST_PROMPT),
      assistantMsg("DIG", "d2", "One-line summary. Keywords: foo", { parentUuid: "d1" }),
      { type: "ai-title", aiTitle: "Misleading title from the summary", sessionId: "DIG" },
    ]);
    writeSession(env.projects, "-repo", "REAL", [userMsg("REAL", "u1", "do a real thing")]);

    const result = runIndex(db);
    expect(result.newMessages).toBe(1); // only REAL's message
    expect(db.query("SELECT COUNT(*) AS c FROM sessions WHERE session_id='DIG'").get()).toEqual({
      c: 0,
    });
    expect(db.query("SELECT COUNT(*) AS c FROM messages WHERE session_id='DIG'").get()).toEqual({
      c: 0,
    });
    // Cursor was recorded, so a second run does not re-scan and re-skip it.
    expect(runIndex(db).filesIndexed).toBe(0);
  });

  test("a digest transcript that grows after detection stays excluded (#42)", () => {
    // The digest run is still writing while the first index detects it. The later
    // lines must not leak into the archive on the next incremental run.
    const path = writeSession(env.projects, "-repo", "DIG", [userMsg("DIG", "d1", DIGEST_PROMPT)]);
    runIndex(db);
    appendRaw(
      path,
      `${JSON.stringify(assistantMsg("DIG", "d2", "the summary", { parentUuid: "d1" }))}\n`,
    );
    // Real run: nothing indexed, no session row appears.
    expect(runIndex(db).newMessages).toBe(0);
    expect(db.query("SELECT COUNT(*) AS c FROM messages WHERE session_id='DIG'").get()).toEqual({
      c: 0,
    });
    expect(db.query("SELECT COUNT(*) AS c FROM sessions WHERE session_id='DIG'").get()).toEqual({
      c: 0,
    });
    // Dry run agrees: the grown digest file is not a candidate.
    appendRaw(path, `${JSON.stringify(assistantMsg("DIG", "d3", "more", { parentUuid: "d2" }))}\n`);
    const plan = dryRunIndex(db);
    expect(plan.candidateMessages).toBe(0);
    expect(plan.filesToRead).toBe(0);
  });

  test("a session that merely contains the digest prompt later is still indexed", () => {
    // The prompt only disqualifies a file when it is the FIRST turn (a digest run).
    // A genuine session that quotes or discusses it mid-conversation is unaffected.
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "let us discuss the cerebro digest prompt"),
      userMsg("S", "u2", DIGEST_PROMPT, { parentUuid: "u1", timestamp: ts(2) }),
    ]);
    runIndex(db);
    expect(countMessages(db)).toBe(2);
    expect(db.query("SELECT COUNT(*) AS c FROM sessions WHERE session_id='S'").get()).toEqual({
      c: 1,
    });
  });

  test("an empty scan does not wipe body_available (transient-failure guard)", () => {
    const path = writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "hi")]);
    runIndex(db);
    require("node:fs").rmSync(path);
    require("node:fs").rmSync(require("node:path").dirname(path), { recursive: true, force: true });
    runIndex(db); // now zero files discovered
    const row = db.query("SELECT body_available FROM sessions WHERE session_id='S'").get() as {
      body_available: number;
    };
    expect(row.body_available).toBe(1);
  });
});

describe("dryRunIndex", () => {
  let env: TempClaude;
  let db: Database;

  beforeEach(() => {
    env = makeClaudeDir();
    process.env.CEREBRO_CLAUDE_DIR = env.claudeRoot;
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
    env.cleanup();
  });

  test("reports candidate messages without writing anything", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "hi"),
      assistantMsg("S", "a1", "yo", { parentUuid: "u1" }),
    ]);
    const plan = dryRunIndex(db);
    expect(plan.candidateMessages).toBe(2);
    expect(plan.newFiles).toBe(1);
    expect(countMessages(db)).toBe(0); // nothing written
  });

  test("after a real index, a dry run sees nothing to do", () => {
    writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "hi")]);
    runIndex(db);
    const plan = dryRunIndex(db);
    expect(plan.filesToRead).toBe(0);
    expect(plan.unchangedFiles).toBe(1);
  });

  test("--full dry run counts the whole archive as candidates", () => {
    writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "hi")]);
    runIndex(db);
    const plan = dryRunIndex(db, true);
    expect(plan.full).toBe(true);
    expect(plan.candidateMessages).toBe(1);
  });

  test("a digest summarization run is not counted (parity with runIndex skip)", () => {
    writeSession(env.projects, "-repo", "DIG", [
      userMsg("DIG", "d1", DIGEST_PROMPT),
      assistantMsg("DIG", "d2", "summary", { parentUuid: "d1" }),
    ]);
    const plan = dryRunIndex(db);
    expect(plan.candidateMessages).toBe(0);
    expect(plan.filesToRead).toBe(0);
  });
});
