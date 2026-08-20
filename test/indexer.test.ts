import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db.ts";
import { DIGEST_PROMPT } from "../src/digest/index.ts";
import { dryRunIndex, runIndex } from "../src/indexer.ts";
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

const countIndexState = (db: Database): number =>
  (db.query("SELECT COUNT(*) AS c FROM index_state").get() as { c: number }).c;

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

  test("a no-op run skips the relink but keeps existing thread links (#82)", () => {
    writeSession(env.projects, "-repo", "ORIG", [
      userMsg("ORIG", "u1", "start", { timestamp: ts(0) }),
      assistantMsg("ORIG", "a1", "ok", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    writeSession(env.projects, "-repo", "RESUME", [
      userMsg("RESUME", "u2", "continue", { parentUuid: "a1", timestamp: ts(2) }),
    ]);
    expect(runIndex(db).relinked).toBe(true);

    const second = runIndex(db); // nothing changed on disk
    expect(second.filesIndexed).toBe(0);
    expect(second.relinked).toBe(false);
    const resume = db
      .query("SELECT parent_session_id, root_session_id FROM sessions WHERE session_id='RESUME'")
      .get() as { parent_session_id: string; root_session_id: string };
    expect(resume.parent_session_id).toBe("ORIG");
    expect(resume.root_session_id).toBe("ORIG");
  });

  test("a resume written after the first run is still relinked on the next run (#82)", () => {
    writeSession(env.projects, "-repo", "ORIG", [
      userMsg("ORIG", "u1", "start", { timestamp: ts(0) }),
      assistantMsg("ORIG", "a1", "ok", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    runIndex(db);
    writeSession(env.projects, "-repo", "RESUME", [
      userMsg("RESUME", "u2", "continue", { parentUuid: "a1", timestamp: ts(2) }),
    ]);
    const second = runIndex(db);
    expect(second.filesIndexed).toBe(1);
    expect(second.relinked).toBe(true);
    const resume = db
      .query("SELECT parent_session_id, root_session_id FROM sessions WHERE session_id='RESUME'")
      .get() as { parent_session_id: string; root_session_id: string };
    expect(resume.parent_session_id).toBe("ORIG");
    expect(resume.root_session_id).toBe("ORIG");
  });

  test("relink picks the true first main-chain turn: NULL ts and sidechain rows cannot shadow it (#44)", () => {
    writeSession(env.projects, "-repo", "ORIG", [
      userMsg("ORIG", "u1", "start", { timestamp: ts(0) }),
      assistantMsg("ORIG", "a1", "ok", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    writeSession(env.projects, "-repo", "RESUME", [
      // The true first turn carries the resume link but has a tolerated missing ts:
      // ordering by id (file order) still picks it, where either ts-based ordering
      // would be shadowed (NULLs-first picks noise, NULLs-last skips this one).
      userMsg("RESUME", "u2", "continue", { parentUuid: "a1", timestamp: undefined }),
      userMsg("RESUME", "u3", "later", { parentUuid: "u2", timestamp: ts(2) }),
    ]);
    // A sidechain turn folded into RESUME: excluded outright by the is_sidechain
    // filter, so it can never carry or shadow the link regardless of ts or id.
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

  test("a subagent file never clobbers the parent's identity fields (invariant #7)", () => {
    writeSession(env.projects, "-repo", "PARENT", [
      userMsg("PARENT", "u1", "do a task"),
      { type: "custom-title", customTitle: "Parent title", sessionId: "PARENT" },
    ]);
    runIndex(db);
    // The subagent transcript shows up later, carrying a different cwd and branch.
    // The parent's top-level file is unchanged, so this run only touches the parent
    // row via touchParentSession: it must refresh the aggregate and nothing else.
    writeSubagent(env.projects, "-repo", "PARENT", "agent-xyz", [
      userMsg("PARENT", "sa1", "subagent prompt", {
        isSidechain: true,
        cwd: "/elsewhere",
        gitBranch: "other-branch",
      }),
    ]);
    runIndex(db);
    const row = db
      .query(
        `SELECT project_path, cwd, git_branch, source_file, title, title_priority, msg_count
         FROM sessions WHERE session_id='PARENT'`,
      )
      .get() as {
      project_path: string;
      cwd: string;
      git_branch: string;
      source_file: string;
      title: string;
      title_priority: number;
      msg_count: number;
    };
    expect(row.project_path).toBe("/repo");
    expect(row.cwd).toBe("/repo");
    expect(row.git_branch).toBe("main");
    expect(row.source_file).toEndWith("PARENT.jsonl");
    expect(row.title).toBe("Parent title");
    expect(row.title_priority).toBe(3);
    expect(row.msg_count).toBe(2); // the aggregate did refresh
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

  test("--rebuild re-flattens stored text of on-disk messages and syncs FTS (#43)", () => {
    writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "the real searchable text")]);
    runIndex(db);
    // Simulate an old flattening generation: stored text differs from a fresh parse.
    db.run("UPDATE messages SET text = 'stale flattening' WHERE uuid = 'u1'");
    db.run("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    runIndex(db, false, true);
    const row = db.query("SELECT text FROM messages WHERE uuid='u1'").get() as { text: string };
    expect(row.text).toBe("the real searchable text");
    // The update trigger kept the FTS index in sync with the refreshed text.
    const hit = db
      .query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'searchable'")
      .get();
    expect(hit).not.toBeNull();
  });

  test("--rebuild keeps messages whose source file is deleted (#43)", () => {
    const path = writeSession(env.projects, "-repo", "GONE", [userMsg("GONE", "ug", "precious")]);
    writeSession(env.projects, "-repo", "KEPT", [userMsg("KEPT", "uk", "still here")]);
    runIndex(db);
    require("node:fs").rmSync(path);
    const result = runIndex(db, false, true);
    expect(result.newMessages).toBe(0);
    // The deleted session's only copy survives the rebuild.
    const row = db.query("SELECT text FROM messages WHERE uuid='ug'").get() as { text: string };
    expect(row.text).toBe("precious");
    const avail = db.query("SELECT body_available FROM sessions WHERE session_id='GONE'").get() as {
      body_available: number;
    };
    expect(avail.body_available).toBe(0);
  });

  test("--rebuild never re-attributes a shared message to the resume (#43)", () => {
    writeSession(env.projects, "-repo", "ORIG", [
      userMsg("ORIG", "u1", "start", { timestamp: ts(0) }),
    ]);
    // The resume file carries a copy of the original's message (same uuid).
    writeSession(env.projects, "-repo", "RESUME", [
      userMsg("RESUME", "u1", "start", { timestamp: ts(0) }),
      userMsg("RESUME", "u2", "continue", { parentUuid: "u1", timestamp: ts(2) }),
    ]);
    runIndex(db);
    runIndex(db, false, true);
    const row = db.query("SELECT session_id FROM messages WHERE uuid='u1'").get() as {
      session_id: string;
    };
    expect(row.session_id).toBe("ORIG");
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

  test("a deleted source file's index_state cursor is pruned, its messages are not", () => {
    const pathA = writeSession(env.projects, "-repo-a", "A", [userMsg("A", "ua", "a")]);
    writeSession(env.projects, "-repo-b", "B", [userMsg("B", "ub", "b")]);
    runIndex(db);
    expect(countIndexState(db)).toBe(2);

    require("node:fs").rmSync(pathA);
    runIndex(db);

    // The cursor is gone, but the archive is not: for a session whose source is
    // deleted the rows here are the only copy (invariant #4).
    expect(countIndexState(db)).toBe(1);
    expect(db.query("SELECT source_file FROM index_state").get()).toEqual({
      source_file: expect.stringContaining("B.jsonl"),
    });
    expect(db.query("SELECT COUNT(*) AS c FROM messages WHERE session_id='A'").get()).toEqual({
      c: 1,
    });
    expect(
      db.query("SELECT body_available FROM sessions WHERE session_id='A'").get(),
    ).toMatchObject({ body_available: 0 });
  });

  test("an empty scan does not wipe index_state (transient-failure guard)", () => {
    const path = writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "hi")]);
    runIndex(db);
    require("node:fs").rmSync(path);
    require("node:fs").rmSync(require("node:path").dirname(path), { recursive: true, force: true });
    runIndex(db); // zero files discovered
    expect(countIndexState(db)).toBe(1);
  });

  test("a pruned file that reappears is re-indexed with no duplicate messages", () => {
    // A second session keeps the scan non-empty, so the transient-failure guard
    // does not short-circuit the prune.
    writeSession(env.projects, "-repo-keep", "K", [userMsg("K", "uk", "keep")]);
    const path = writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "hello")]);
    const raw = require("node:fs").readFileSync(path);
    runIndex(db);
    require("node:fs").rmSync(path);
    runIndex(db);
    expect(countIndexState(db)).toBe(1); // only the keeper

    // Re-read from byte 0; UUID dedup makes that a no-op (invariant #4).
    require("node:fs").writeFileSync(path, raw);
    expect(runIndex(db).newMessages).toBe(0);
    expect(countMessages(db)).toBe(2);
    expect(countIndexState(db)).toBe(2);
  });

  test("an is_digest flag survives a prune when its file still exists", () => {
    writeSession(env.projects, "-repo", "DIG", [userMsg("DIG", "d1", DIGEST_PROMPT)]);
    const pathGone = writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "hi")]);
    runIndex(db);
    expect(db.query("SELECT COUNT(*) AS c FROM index_state WHERE is_digest=1").get()).toEqual({
      c: 1,
    });

    require("node:fs").rmSync(pathGone);
    runIndex(db);

    const rows = db.query("SELECT source_file, is_digest FROM index_state").all() as {
      source_file: string;
      is_digest: number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_digest).toBe(1);
  });

  test("one unreadable file is skipped and reported through the sink, the rest completes", () => {
    const badPath = writeSession(env.projects, "-repo", "BAD", [userMsg("BAD", "b1", "hidden")]);
    writeSession(env.projects, "-repo", "OK", [userMsg("OK", "u1", "still indexed")]);
    require("node:fs").chmodSync(badPath, 0o000);

    const skips: string[] = [];
    const result = runIndex(db, false, false, { onSkip: (line) => skips.push(line) });

    // The good file made it in; the bad one was skipped, not fatal.
    expect(countMessages(db)).toBe(1);
    expect(result.filesScanned).toBe(2);
    expect(result.filesIndexed).toBe(1);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("skipped");
    expect(skips[0]).toContain(badPath);

    // Restore so cleanup can remove the directory.
    require("node:fs").chmodSync(badPath, 0o644);
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
