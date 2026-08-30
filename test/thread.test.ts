import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db.ts";
import { runIndex } from "../src/indexer.ts";
import {
  attachThreadDisplay,
  countThreads,
  messageOrdinal,
  noThreadDisplay,
  rootOf,
  type ThreadDisplay,
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

  describe("messageOrdinal", () => {
    test("matches the position in threadMessages' (ts, id) order across the whole thread", () => {
      seedThread();
      // Same ordering threadMessages uses; the ordinal of the i-th row must be i+1.
      const rows = db
        .query(
          `SELECT id FROM messages
           WHERE session_id IN (SELECT session_id FROM sessions WHERE root_session_id = 'ORIG')
           ORDER BY ts, id`,
        )
        .all() as { id: number }[];
      rows.forEach((row, i) => {
        expect(messageOrdinal(db, "ORIG", row.id)).toBe(i + 1);
      });
    });

    test("a NULL-ts message sorts first, before every timestamped turn", () => {
      // Pins the NULLs-first ASC semantics the ordinal shares with threadMessages:
      // a tolerated missing timestamp must not push the message to the end.
      writeSession(env.projects, "-repo", "S", [
        userMsg("S", "u1", "first with ts", { timestamp: ts(0) }),
        userMsg("S", "u2", "no timestamp", { timestamp: null }),
        assistantMsg("S", "a1", "answer", { parentUuid: "u1", timestamp: ts(1) }),
      ]);
      runIndex(db);
      const idOf = (text: string): number =>
        (db.query("SELECT id FROM messages WHERE text = ?").get(text) as { id: number }).id;
      expect(messageOrdinal(db, "S", idOf("no timestamp"))).toBe(1);
      expect(messageOrdinal(db, "S", idOf("first with ts"))).toBe(2);
      expect(messageOrdinal(db, "S", idOf("answer"))).toBe(3);
    });

    test("returns 0 for an id that is not in the thread", () => {
      seedThread();
      expect(messageOrdinal(db, "ORIG", 999_999)).toBe(0);
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
      // Distinct message UUIDs: dedup is keyed on the UUID alone (invariant #4), so
      // reusing one across the two files would drop B's only message and leave it a
      // zero-message session, which the threads view no longer counts (#83).
      writeSession(env.projects, "-repo", "A", [userMsg("A", "ua", "a", { timestamp: ts(0) })]);
      writeSession(env.projects, "-repo", "B", [userMsg("B", "ub", "b", { timestamp: ts(1) })]);
      runIndex(db);
      expect(countThreads(db)).toBe(2);
    });
  });

  // The step every ranked-hit path runs after dedup. Its whole reason to exist is
  // that the two fallback policies used to be three copies that could drift apart
  // without anything noticing.
  describe("attachThreadDisplay", () => {
    const seedTwo = (): void => {
      writeSession(env.projects, "-repo", "A", [
        userMsg("A", "ua", "alpha", { timestamp: ts(0) }),
        { type: "custom-title", customTitle: "Alpha thread", sessionId: "A" },
      ]);
      writeSession(env.projects, "-other", "B", [
        userMsg("B", "ub", "beta", { cwd: "/other", timestamp: ts(1) }),
      ]);
      runIndex(db);
    };

    test("attaches the thread's rollup identity to each hit", () => {
      seedTwo();
      const rows = attachThreadDisplay(db, [{ root: "A" }, { root: "B" }], {
        fallback: noThreadDisplay,
        build: (hit, display) => ({ id: hit.root, ...display }),
      });
      expect(rows).toEqual([
        {
          id: "A",
          last_ts: ts(0),
          project_path: "/repo",
          provider: "claude-code",
          model: null,
          title: "Alpha thread",
        },
        {
          id: "B",
          last_ts: ts(1),
          project_path: "/other",
          provider: "claude-code",
          model: null,
          title: null,
        },
      ]);
    });

    test("the null policy keeps a hit whose thread has no rollup row", () => {
      // A summary outlives its sessions rows, so the hit must survive with its
      // identity emptied rather than be dropped.
      seedTwo();
      db.run("DELETE FROM sessions WHERE session_id = 'B'");
      const rows = attachThreadDisplay(db, [{ root: "B" }], {
        fallback: noThreadDisplay,
        build: (hit, display) => ({ id: hit.root, ...display }),
      });
      expect(rows).toEqual([
        { id: "B", last_ts: null, project_path: null, provider: null, model: null, title: null },
      ]);
    });

    test("the session-row policy answers from what the hit itself carries", () => {
      // `search`'s policy: the matched message's own session row is a better answer
      // than nothing when the rollup has nothing to say.
      seedTwo();
      db.run("DELETE FROM sessions WHERE session_id = 'B'");
      const own: ThreadDisplay = {
        last_ts: null,
        project_path: "/from-the-session",
        provider: "claude-code",
        model: "opus-test",
        title: "From the session row",
      };
      const rows = attachThreadDisplay(db, [{ root: "A" }, { root: "B" }], {
        fallback: () => own,
        build: (hit, display) => ({ id: hit.root, title: display.title }),
      });
      // A alone has a rollup, so only B falls back.
      expect(rows).toEqual([
        { id: "A", title: "Alpha thread" },
        { id: "B", title: "From the session row" },
      ]);
    });

    test("hydrates once for the whole batch, deduplicating repeated roots", () => {
      // Two hits in one thread must not mean two rollup queries; the ordering and
      // the per-hit result stay unchanged.
      seedTwo();
      let queries = 0;
      const real = db.query.bind(db);
      db.query = ((sql: string) => {
        if (sql.includes("FROM threads WHERE id IN")) queries++;
        return real(sql);
      }) as typeof db.query;
      try {
        const rows = attachThreadDisplay(db, [{ root: "A" }, { root: "B" }, { root: "A" }], {
          fallback: noThreadDisplay,
          build: (hit, display) => ({ id: hit.root, title: display.title }),
        });
        expect(rows.map((row) => row.id)).toEqual(["A", "B", "A"]);
        expect(rows[2]!.title).toBe("Alpha thread");
      } finally {
        Reflect.deleteProperty(db, "query");
      }
      expect(queries).toBe(1);
    });

    test("an empty hit list does no work", () => {
      expect(
        attachThreadDisplay(db, [], { fallback: noThreadDisplay, build: (hit) => hit }),
      ).toEqual([]);
    });
  });
});
