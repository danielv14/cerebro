import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db.ts";
import { runIndex } from "../src/indexer.ts";
import {
  countThreads,
  rootOf,
  threadLastTs,
  threadMessages,
  threadOpeningPrompt,
} from "../src/thread.ts";
import {
  assistantMsg,
  makeClaudeDir,
  type TempClaude,
  ts,
  userMsg,
  writeSession,
  writeSubagent,
} from "./fixtures.ts";

describe("thread (identity + membership)", () => {
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

  // A thread: ORIG (root) + RESUME (resume branching from ORIG) + a subagent folded
  // into RESUME (its sessionId field is the parent, RESUME). Indexing relinks RESUME
  // to ORIG and folds the subagent's turns into RESUME.
  const seedThread = (): void => {
    writeSession(env.projects, "-repo", "ORIG", [
      userMsg("ORIG", "u1", "start", { timestamp: ts(0) }),
      assistantMsg("ORIG", "a1", "ok", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    writeSession(env.projects, "-repo", "RESUME", [
      userMsg("RESUME", "u2", "more", { parentUuid: "a1", timestamp: ts(2) }),
    ]);
    writeSubagent(env.projects, "-repo", "RESUME", "agent-1", [
      userMsg("RESUME", "su1", "subagent prompt", { isSidechain: true, timestamp: ts(3) }),
      assistantMsg("RESUME", "sa1", "subagent reply", {
        isSidechain: true,
        parentUuid: "su1",
        timestamp: ts(4),
      }),
    ]);
    runIndex(db);
  };

  describe("rootOf", () => {
    test("resolves a root, a resume, and a folded-subagent parent to the thread root", () => {
      seedThread();
      expect(rootOf(db, "ORIG")).toBe("ORIG"); // root resolves to itself
      expect(rootOf(db, "RESUME")).toBe("ORIG"); // resume resolves to the root
      // The subagent folds into its parent session (RESUME), which resolves to ORIG.
      expect(rootOf(db, "RESUME")).toBe("ORIG");
    });

    test("falls back to the given id for an unknown or not-yet-relinked session", () => {
      seedThread();
      // No session row at all: preserve the historical `?? sessionId` fallback.
      expect(rootOf(db, "does-not-exist")).toBe("does-not-exist");
      // A row that exists but has not been relinked (NULL root) falls back to itself.
      db.run("INSERT INTO sessions (session_id, root_session_id) VALUES ('UNLINKED', NULL)");
      expect(rootOf(db, "UNLINKED")).toBe("UNLINKED");
    });
  });

  describe("threadMessages", () => {
    test("returns the whole thread (root + resume + folded subagent turns), ordered by ts then id", () => {
      seedThread();
      const fromRoot = threadMessages(db, "ORIG");
      const fromResume = threadMessages(db, "RESUME");

      // Any id in the thread yields the same whole-thread transcript.
      expect(fromRoot).toEqual(fromResume);
      expect(fromRoot.map((m) => m.text)).toEqual([
        "start",
        "ok",
        "more",
        "subagent prompt",
        "subagent reply",
      ]);
      // The subagent turns are present and flagged as sidechain.
      const sidechain = fromRoot.filter((m) => m.is_sidechain === 1);
      expect(sidechain.map((m) => m.text)).toEqual(["subagent prompt", "subagent reply"]);
    });

    test("returns an empty array for an unknown id", () => {
      seedThread();
      expect(threadMessages(db, "does-not-exist")).toEqual([]);
    });
  });

  describe("threadOpeningPrompt", () => {
    test("returns the earliest non-sidechain user turn, preferring prose over a command echo", () => {
      writeSession(env.projects, "-repo", "S", [
        userMsg("S", "u1", "<command-name>/clear</command-name>", { timestamp: ts(0) }),
        userMsg("S", "u2", "the real opening question", { timestamp: ts(1) }),
        assistantMsg("S", "a1", "answer", { parentUuid: "u2", timestamp: ts(2) }),
      ]);
      runIndex(db);
      // Prose wins over the earlier `<command-` echo despite its later timestamp.
      expect(threadOpeningPrompt(db, "S")).toBe("the real opening question");
    });

    test("returns null for a thread with no user turn", () => {
      expect(threadOpeningPrompt(db, "does-not-exist")).toBeNull();
    });
  });

  describe("threadLastTs", () => {
    test("is the max activity across the thread's sessions, including folded subagent turns", () => {
      seedThread();
      // ORIG ends at ts(1), RESUME at ts(2), the subagent (folded into RESUME) at ts(4).
      expect(threadLastTs(db, "ORIG")).toBe(ts(4));
    });

    test("is null for an unknown thread root", () => {
      expect(threadLastTs(db, "does-not-exist")).toBeNull();
    });
  });

  describe("countThreads", () => {
    test("counts a root once; its resumes and folded subagents do not inflate it", () => {
      seedThread();
      // ORIG + RESUME + the subagent folded into RESUME are one logical thread.
      expect(countThreads(db)).toBe(1);
    });

    test("counts each distinct root, and is zero for an empty archive", () => {
      expect(countThreads(db)).toBe(0);
      writeSession(env.projects, "-repo", "A", [userMsg("A", "u1", "a", { timestamp: ts(0) })]);
      writeSession(env.projects, "-repo", "B", [userMsg("B", "u1", "b", { timestamp: ts(1) })]);
      runIndex(db);
      expect(countThreads(db)).toBe(2);
    });
  });
});
