import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db.ts";
import { runIndex } from "../src/indexer.ts";
import {
  DIGEST_PROMPT,
  DIGEST_PROMPT_VERSION,
  staleThreads,
  writeSummary,
  getSummary,
  searchSummaries,
} from "../src/digest.ts";
import {
  makeClaudeDir,
  writeSession,
  appendRaw,
  userMsg,
  assistantMsg,
  ts,
  type TempClaude,
} from "./fixtures.ts";

describe("DIGEST_PROMPT", () => {
  test("is a substantial prompt that asks for a Keywords line and covers routine sessions", () => {
    expect(DIGEST_PROMPT.length).toBeGreaterThan(400);
    expect(DIGEST_PROMPT).toContain("Keywords:");
    expect(DIGEST_PROMPT.toLowerCase()).toContain("routine");
    expect(DIGEST_PROMPT.toLowerCase()).toContain("output only the summary");
  });
});

describe("digest (summaries layer)", () => {
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

  test("staleThreads lists never-summarized threads, then excludes summarized ones", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "do the thing", { timestamp: ts(0) }),
      assistantMsg("S", "a1", "done", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    runIndex(db);

    const before = staleThreads(db);
    expect(before.map((t) => t.id)).toEqual(["S"]);
    expect(before[0]!.summary_version).toBeNull();

    writeSummary(db, "S", "Summary of S. Keywords: thing");
    expect(staleThreads(db).length).toBe(0);
  });

  test("a thread becomes stale again when new messages arrive after its summary", () => {
    const path = writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "start", { timestamp: ts(0) }),
      assistantMsg("S", "a1", "ok", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    runIndex(db);
    writeSummary(db, "S", "First summary. Keywords: start");
    expect(staleThreads(db).length).toBe(0);

    appendRaw(
      path,
      JSON.stringify(assistantMsg("S", "a2", "more work later", { parentUuid: "a1", timestamp: ts(100) })) +
        "\n",
    );
    runIndex(db);

    const stale = staleThreads(db);
    expect(stale.map((t) => t.id)).toEqual(["S"]);
  });

  test("a thread becomes stale when its summary was written by an older prompt version", () => {
    writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "work", { timestamp: ts(0) })]);
    runIndex(db);
    writeSummary(db, "S", "Summary. Keywords: work");
    expect(staleThreads(db).length).toBe(0);

    db.run("UPDATE summaries SET prompt_version = ? WHERE root_session_id = 'S'", [
      DIGEST_PROMPT_VERSION - 1,
    ]);
    const stale = staleThreads(db);
    expect(stale.map((t) => t.id)).toEqual(["S"]);
    expect(stale[0]!.summary_version).toBe(DIGEST_PROMPT_VERSION - 1);
  });

  test("writeSummary upserts: re-summarizing replaces the row and the FTS text", () => {
    writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "work", { timestamp: ts(0) })]);
    runIndex(db);

    writeSummary(db, "S", "First version migrating to drizzle. Keywords: drizzle");
    expect(searchSummaries(db, "drizzle").map((h) => h.id)).toEqual(["S"]);

    writeSummary(db, "S", "Second version migrating to knex. Keywords: knex");
    expect(getSummary(db, "S")!.summary).toContain("knex");
    expect((db.query("SELECT COUNT(*) AS c FROM summaries").get() as { c: number }).c).toBe(1);
    // The old text is gone from the index, the new text is searchable.
    expect(searchSummaries(db, "drizzle").length).toBe(0);
    expect(searchSummaries(db, "knex").map((h) => h.id)).toEqual(["S"]);
  });

  test("writeSummary attributes a resume's summary to the thread root", () => {
    writeSession(env.projects, "-repo", "ORIG", [
      userMsg("ORIG", "u1", "start", { timestamp: ts(0) }),
      assistantMsg("ORIG", "a1", "ok", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    writeSession(env.projects, "-repo", "RESUME", [
      userMsg("RESUME", "u2", "more", { parentUuid: "a1", timestamp: ts(2) }),
    ]);
    runIndex(db);

    const root = writeSummary(db, "RESUME", "Thread summary. Keywords: start, more");
    expect(root).toBe("ORIG");
    expect(getSummary(db, "ORIG")!.summary).toContain("Thread summary");
    // The whole thread now counts as summarized.
    expect(staleThreads(db).length).toBe(0);
  });

  test("searchSummaries ranks by topic, brackets the match, and ignores stopword queries", () => {
    writeSession(env.projects, "-repo-a", "A", [userMsg("A", "ua", "a", { timestamp: ts(0) })]);
    writeSession(env.projects, "-repo-b", "B", [userMsg("B", "ub", "b", { timestamp: ts(10) })]);
    runIndex(db);
    writeSummary(db, "A", "Set up the rate limiter middleware. Keywords: rate-limiter");
    writeSummary(db, "B", "Refactor the checkout flow. Keywords: checkout");

    const hits = searchSummaries(db, "how did the rate limiter work");
    expect(hits.map((h) => h.id)).toEqual(["A"]);
    expect(hits[0]!.snippet).toContain("[limiter]");

    expect(searchSummaries(db, "och att den vi kan").length).toBe(0);
  });

  test("getSummary returns null when nothing is stored", () => {
    writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "work", { timestamp: ts(0) })]);
    runIndex(db);
    expect(getSummary(db, "S")).toBeNull();
  });
});
