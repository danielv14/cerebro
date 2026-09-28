import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db.ts";
import { countStaleThreads } from "../src/digest/stale.ts";
import { searchSummaries, writeSummary } from "../src/digest/store.ts";
import { runIndex } from "../src/indexer.ts";
import { relevantThreads } from "../src/relevance.ts";
import { search } from "../src/search.ts";
import {
  attachThreadIdentity,
  countThreads,
  messageOrdinal,
  relinkThreads,
  rootOf,
  threadIdentity,
  threadLastTs,
  threadMessages,
  threadOpeningPrompt,
} from "../src/thread.ts";
import {
  assistantMsg,
  countQueriesMatching,
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
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
    env.cleanup();
  });

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
    runIndex(db, { adapters: env.adapters });
  };

  describe("rootOf", () => {
    test("resolves a root, a resume, and a folded-subagent parent to the thread root", () => {
      seedThread();
      expect(rootOf(db, "ORIG")).toBe("ORIG");
      expect(rootOf(db, "RESUME")).toBe("ORIG");
      expect(db.query("SELECT session_id FROM messages WHERE uuid='su1'").get()).toEqual({
        session_id: "RESUME",
      });
    });

    test("falls back to the given id for an unknown session", () => {
      seedThread();
      expect(rootOf(db, "does-not-exist")).toBe("does-not-exist");
    });
  });

  describe("relinkThreads", () => {
    const totalChanges = (): number =>
      (db.query("SELECT total_changes() AS c").get() as { c: number }).c;

    test("a relink with nothing to change writes no rows (#202)", () => {
      seedThread();
      const before = totalChanges();
      relinkThreads(db);
      expect(totalChanges()).toBe(before);
      expect(rootOf(db, "RESUME")).toBe("ORIG");
    });

    test("only the row whose link moved is rewritten", () => {
      seedThread();
      db.run("UPDATE sessions SET root_session_id = 'RESUME' WHERE session_id = 'RESUME'");
      const before = totalChanges();
      relinkThreads(db);
      expect(totalChanges() - before).toBe(1);
      expect(rootOf(db, "RESUME")).toBe("ORIG");
    });

    test("the link comes from the first main-chain turn, not a sidechain turn (#201)", () => {
      writeSession(env.projects, "-repo", "ORIG", [
        userMsg("ORIG", "u1", "start", { timestamp: ts(0) }),
      ]);
      writeSession(env.projects, "-repo", "OTHER", [
        userMsg("OTHER", "o1", "unrelated", { timestamp: ts(1) }),
      ]);
      writeSession(env.projects, "-repo", "RESUME", [
        userMsg("RESUME", "s1", "side", { parentUuid: "o1", isSidechain: true, timestamp: ts(2) }),
        userMsg("RESUME", "u2", "main", { parentUuid: "u1", timestamp: ts(3) }),
      ]);
      runIndex(db, { adapters: env.adapters });
      expect(rootOf(db, "RESUME")).toBe("ORIG");
      expect(rootOf(db, "OTHER")).toBe("OTHER");
    });
  });

  describe("summaries across a reroot (#206)", () => {
    const summaryKeys = (): string[] =>
      (
        db.query("SELECT root_session_id FROM summaries ORDER BY 1").all() as {
          root_session_id: string;
        }[]
      ).map((row) => row.root_session_id);

    const indexResumeThenOriginal = (summarizeOriginalFirst: boolean): void => {
      writeSession(env.projects, "-repo", "RESUME", [
        userMsg("RESUME", "u2", "carry on with the limiter", {
          parentUuid: "a1",
          timestamp: ts(2),
        }),
      ]);
      runIndex(db, { adapters: env.adapters });
      writeSummary(db, "RESUME", "Resume summary about the limiter. Keywords: limiter");
      // An id with no sessions row is its own root, so this keys the summary on ORIG.
      if (summarizeOriginalFirst) writeSummary(db, "ORIG", "Original summary. Keywords: original");
      writeSession(env.projects, "-repo", "ORIG", [
        userMsg("ORIG", "u1", "start", { timestamp: ts(0) }),
        assistantMsg("ORIG", "a1", "ok", { parentUuid: "u1", timestamp: ts(1) }),
      ]);
      runIndex(db, { adapters: env.adapters });
      expect(rootOf(db, "RESUME")).toBe("ORIG");
    };

    test("the summary moves to the new root, marked stale", () => {
      indexResumeThenOriginal(false);
      expect(summaryKeys()).toEqual(["ORIG"]);
      const row = db
        .query("SELECT source_last_ts FROM summaries WHERE root_session_id = 'ORIG'")
        .get() as { source_last_ts: string | null };
      expect(row.source_last_ts).toBeNull();
      expect(searchSummaries(db, "limiter").map((hit) => hit.id)).toEqual(["ORIG"]);
    });

    test("a root that already has a summary keeps it and the orphan is dropped", () => {
      indexResumeThenOriginal(true);
      expect(summaryKeys()).toEqual(["ORIG"]);
      expect(searchSummaries(db, "limiter")).toEqual([]);
      expect(searchSummaries(db, "original").map((hit) => hit.id)).toEqual(["ORIG"]);
    });

    test("an orphan newer than the root's own summary replaces it", () => {
      writeSummary(db, "ORIG", "Older original summary. Keywords: original");
      db.run("UPDATE summaries SET summarized_at = '2026-01-01T00:00:00.000Z'");
      writeSession(env.projects, "-repo", "RESUME", [
        userMsg("RESUME", "u2", "carry on with the limiter", {
          parentUuid: "a1",
          timestamp: ts(2),
        }),
      ]);
      runIndex(db, { adapters: env.adapters });
      writeSummary(db, "RESUME", "Newer resume summary about the limiter. Keywords: limiter");
      writeSession(env.projects, "-repo", "ORIG", [
        userMsg("ORIG", "u1", "start", { timestamp: ts(0) }),
        assistantMsg("ORIG", "a1", "ok", { parentUuid: "u1", timestamp: ts(1) }),
      ]);
      runIndex(db, { adapters: env.adapters });

      expect(summaryKeys()).toEqual(["ORIG"]);
      expect(searchSummaries(db, "limiter").map((hit) => hit.id)).toEqual(["ORIG"]);
      expect(searchSummaries(db, "original")).toEqual([]);
    });

    test("a summary whose sessions rows are gone is left alone", () => {
      writeSummary(db, "GONE", "Summary of a thread whose sessions were never indexed.");
      seedThread();
      expect(summaryKeys()).toEqual(["GONE"]);
    });
  });

  describe("threadMessages", () => {
    test("returns the whole thread (root + resume + folded subagent turns), ordered by ts then id", () => {
      seedThread();
      const fromRoot = threadMessages(db, "ORIG");
      const fromResume = threadMessages(db, "RESUME");

      expect(fromRoot).toEqual(fromResume);
      expect(fromRoot.map((m) => m.text)).toEqual([
        "start",
        "ok",
        "more",
        "subagent prompt",
        "subagent reply",
      ]);
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
      runIndex(db, { adapters: env.adapters });
      expect(threadOpeningPrompt(db, "S")).toBe("the real opening question");
    });

    test("shows what the user typed when the session opens with a skill", () => {
      // Claude Code records the slash command as one user turn and injects the
      // skill body as the next one. Neither is prose.
      writeSession(env.projects, "-repo", "K", [
        userMsg(
          "K",
          "u1",
          "<command-message>retro</command-message>\n" +
            "<command-name>/retro</command-name>\n" +
            "<command-args>senaste tva veckorna</command-args>",
          { timestamp: ts(0) },
        ),
        userMsg(
          "K",
          "u2",
          "Base directory for this skill: /Users/x/.claude/skills/retro\n\n# Retro\n\nGenerera en retro.",
          { timestamp: ts(1) },
        ),
        assistantMsg("K", "a1", "answer", { parentUuid: "u2", timestamp: ts(2) }),
      ]);
      runIndex(db, { adapters: env.adapters });
      expect(threadOpeningPrompt(db, "K")).toBe("senaste tva veckorna");
    });

    test("falls back to the command name when the slash command carried no arguments", () => {
      writeSession(env.projects, "-repo", "N", [
        userMsg(
          "N",
          "u1",
          "<command-message>standup</command-message>\n<command-name>/standup</command-name>",
          {
            timestamp: ts(0),
          },
        ),
        userMsg(
          "N",
          "u2",
          "Base directory for this skill: /Users/x/.claude/skills/standup\n\n# Standup",
          {
            timestamp: ts(1),
          },
        ),
      ]);
      runIndex(db, { adapters: env.adapters });
      expect(threadOpeningPrompt(db, "N")).toBe("/standup");
    });

    test("a prompt that opens with a bracket is still the user's words (#216)", () => {
      writeSession(env.projects, "-repo", "W", [
        userMsg("W", "u1", "[WIP] fix the thing", { timestamp: ts(0) }),
        userMsg("W", "u2", "and the other thing", { timestamp: ts(1) }),
      ]);
      runIndex(db, { adapters: env.adapters });
      expect(threadOpeningPrompt(db, "W")).toBe("[WIP] fix the thing");
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

    test("a summary's coverage point is the threads view's last_ts (#214)", () => {
      seedThread();
      writeSummary(db, "RESUME", "Summary of the whole thread. Keywords: start");
      const view = db.query("SELECT last_ts FROM threads WHERE id = 'ORIG'").get() as {
        last_ts: string;
      };
      const stored = db
        .query("SELECT source_last_ts FROM summaries WHERE root_session_id = 'ORIG'")
        .get() as { source_last_ts: string };
      expect(stored.source_last_ts).toBe(view.last_ts);
      expect(countStaleThreads(db)).toBe(0);
    });
  });

  describe("messageOrdinal", () => {
    test("matches the position in threadMessages' (ts, id) order across the whole thread", () => {
      seedThread();
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
      writeSession(env.projects, "-repo", "S", [
        userMsg("S", "u1", "first with ts", { timestamp: ts(0) }),
        userMsg("S", "u2", "no timestamp", { timestamp: null }),
        assistantMsg("S", "a1", "answer", { parentUuid: "u1", timestamp: ts(1) }),
      ]);
      runIndex(db, { adapters: env.adapters });
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
      expect(countThreads(db)).toBe(1);
    });

    test("counts each distinct root, and is zero for an empty archive", () => {
      expect(countThreads(db)).toBe(0);
      // Distinct message UUIDs: dedup is keyed on the UUID alone (invariant #4), so
      // reusing one across the two files would drop B's only message and leave it a
      // zero-message session, which the threads view excludes.
      writeSession(env.projects, "-repo", "A", [userMsg("A", "ua", "a", { timestamp: ts(0) })]);
      writeSession(env.projects, "-repo", "B", [userMsg("B", "ub", "b", { timestamp: ts(1) })]);
      runIndex(db, { adapters: env.adapters });
      expect(countThreads(db)).toBe(2);
    });
  });

  describe("attachThreadIdentity", () => {
    const seedTwo = (): void => {
      writeSession(env.projects, "-repo", "A", [
        userMsg("A", "ua", "alpha", { timestamp: ts(0) }),
        { type: "custom-title", customTitle: "Alpha thread", sessionId: "A" },
      ]);
      writeSession(env.projects, "-other", "B", [
        userMsg("B", "ub", "beta", { cwd: "/other", timestamp: ts(1) }),
      ]);
      runIndex(db, { adapters: env.adapters });
    };

    test("attaches the thread's rollup identity to each hit", () => {
      seedTwo();
      const rows = attachThreadIdentity(db, [{ id: "A" }, { id: "B" }]).map(
        ({ identity }) => identity,
      );
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
      seedTwo();
      db.run("DELETE FROM sessions WHERE session_id = 'B'");
      const rows = attachThreadIdentity(db, [{ id: "B" }]).map(({ identity }) => identity);
      expect(rows).toEqual([
        { id: "B", last_ts: null, project_path: null, provider: null, model: null, title: null },
      ]);
    });

    test("hydrates once for the whole batch, deduplicating repeated threads", () => {
      seedTwo();
      let rows: { id: string; title: string | null }[] = [];
      const queries = countQueriesMatching(db, "FROM threads WHERE id IN", () => {
        rows = attachThreadIdentity(db, [{ id: "A" }, { id: "B" }, { id: "A" }]).map(
          ({ identity }) => ({ id: identity.id, title: identity.title }),
        );
      });
      expect(queries).toBe(1);
      expect(rows.map((row) => row.id)).toEqual(["A", "B", "A"]);
      expect(rows[2]!.title).toBe("Alpha thread");
    });

    // The JSON these commands print is consumed by hooks and agents, so the key order is part of
    // the contract, not an accident of how the row is built.
    test("the display fields land in one order across every listing", () => {
      seedTwo();
      writeSummary(db, "A", "Alpha work on the limiter. Keywords: alpha, limiter");

      expect(Object.keys(threadIdentity("A"))).toEqual([
        "id",
        "last_ts",
        "project_path",
        "provider",
        "model",
        "title",
      ]);
      expect(Object.keys(relevantThreads(db, "alpha limiter", 3)[0]!)).toEqual([
        "id",
        "last_ts",
        "project_path",
        "provider",
        "model",
        "title",
        "snippet",
        "opening",
        "fromSummary",
      ]);
      expect(Object.keys(searchSummaries(db, "alpha limiter")[0]!)).toEqual([
        "id",
        "last_ts",
        "project_path",
        "provider",
        "model",
        "title",
        "snippet",
      ]);
      // search builds its row by hand and shows the message's own ts and branch,
      // so it carries no thread last_ts at all.
      expect(Object.keys(search(db, "alpha")[0]!)).toEqual([
        "message_id",
        "session_id",
        "ts",
        "role",
        "project_path",
        "git_branch",
        "provider",
        "model",
        "title",
        "snippet",
        "ordinal",
      ]);
    });

    test("an empty hit list does no work", () => {
      expect(attachThreadIdentity(db, [])).toEqual([]);
    });
  });
});
