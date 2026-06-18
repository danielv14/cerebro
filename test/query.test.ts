import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db.ts";
import { runIndex } from "../src/indexer.ts";
import {
  search,
  listThreads,
  recentThreads,
  relevantThreads,
  resolveSession,
  openingPrompt,
  stats,
  toMatchQuery,
} from "../src/query.ts";
import { writeSummary } from "../src/digest.ts";
import {
  makeClaudeDir,
  writeSession,
  userMsg,
  assistantMsg,
  ts,
  type TempClaude,
} from "./fixtures.ts";

describe("toMatchQuery", () => {
  test("builds an OR-of-tokens query and drops stopwords", () => {
    expect(toMatchQuery("hur fungerar cerebro indexering")).toBe(
      '"fungerar" OR "cerebro" OR "indexering"',
    );
  });

  test("returns null when the prompt is all stopwords", () => {
    expect(toMatchQuery("och att den vi kan")).toBeNull();
  });

  test("returns null for empty / punctuation-only input", () => {
    expect(toMatchQuery("")).toBeNull();
    expect(toMatchQuery("   ... !!!")).toBeNull();
  });

  test("dedupes repeated tokens", () => {
    expect(toMatchQuery("drizzle drizzle drizzle")).toBe('"drizzle"');
  });
});

describe("query (populated archive)", () => {
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

  test("search returns ranked hits with a highlighted snippet", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "add a token bucket rate limiter to the middleware"),
      assistantMsg("S", "a1", "unrelated text about colors", { parentUuid: "u1" }),
    ]);
    runIndex(db);
    const hits = search(db, "limiter", 10);
    expect(hits.length).toBe(1);
    expect(hits[0]!.session_id).toBe("S");
    expect(hits[0]!.snippet).toContain("[limiter]");
  });

  test("listThreads lists roots newest-first and filters by project after grouping", () => {
    writeSession(env.projects, "-repo-a", "A", [
      userMsg("A", "ua", "alpha", { cwd: "/repo-a", timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo-b", "B", [
      userMsg("B", "ub", "beta", { cwd: "/repo-b", timestamp: ts(10) }),
    ]);
    runIndex(db);
    const all = listThreads(db, {});
    expect(all.length).toBe(2);
    expect(all[0]!.id).toBe("B"); // newest first

    const filtered = listThreads(db, { project: "repo-a" });
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.id).toBe("A");
  });

  test("listThreads aggregates a resume's messages into the thread total", () => {
    writeSession(env.projects, "-repo", "ORIG", [
      userMsg("ORIG", "u1", "start", { cwd: "/repo", timestamp: ts(0) }),
      assistantMsg("ORIG", "a1", "ok", { cwd: "/repo", parentUuid: "u1", timestamp: ts(1) }),
    ]);
    writeSession(env.projects, "-repo", "RESUME", [
      userMsg("RESUME", "u2", "more", { cwd: "/repo", parentUuid: "a1", timestamp: ts(2) }),
    ]);
    runIndex(db);
    const threads = listThreads(db, { project: "repo" });
    expect(threads.length).toBe(1);
    expect(threads[0]!.id).toBe("ORIG");
    expect(threads[0]!.msgs).toBe(3);
    expect(threads[0]!.sessions_in_thread).toBe(2);
  });

  test("recentThreads scopes by project_path and respects the recency cutoff", () => {
    writeSession(env.projects, "-repo-x", "X", [
      userMsg("X", "ux", "work in x", { cwd: "/repo-x", timestamp: ts(0) }),
    ]);
    runIndex(db);

    const hit = recentThreads(db, { cwd: "/repo-x", since: ts(-100000), limit: 5 });
    expect(hit.map((t) => t.id)).toEqual(["X"]);

    const otherRepo = recentThreads(db, { cwd: "/repo-y", since: ts(-100000), limit: 5 });
    expect(otherRepo.length).toBe(0);

    const tooOld = recentThreads(db, { cwd: "/repo-x", since: ts(100000), limit: 5 });
    expect(tooOld.length).toBe(0);
  });

  test("relevantThreads finds threads by prompt, with opening prompt and snippet", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "migrate the database layer from drizzle to knex"),
      assistantMsg("S", "a1", "done, the knex migration is complete", { parentUuid: "u1" }),
    ]);
    runIndex(db);

    const hits = relevantThreads(db, "how did the knex migration go", 3);
    expect(hits.length).toBe(1);
    expect(hits[0]!.id).toBe("S");
    expect(hits[0]!.opening).toContain("drizzle to knex");
    expect(hits[0]!.snippet.toLowerCase()).toContain("knex");
  });

  test("relevantThreads prefers a thread's summary snippet over the raw transcript", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "migrate the database layer from drizzle to knex"),
      assistantMsg("S", "a1", "done, the knex migration is complete", { parentUuid: "u1" }),
    ]);
    runIndex(db);
    // "Refactored" appears only in the summary, never in the raw transcript.
    writeSummary(db, "S", "Refactored to knex");

    const hits = relevantThreads(db, "knex", 3);
    expect(hits.length).toBe(1);
    expect(hits[0]!.id).toBe("S");
    expect(hits[0]!.fromSummary).toBe(true);
    // Snippet comes from the curated summary, not the raw transcript.
    expect(hits[0]!.snippet).toContain("Refactored");
    expect(hits[0]!.snippet).toContain("[knex]");
  });

  test("relevantThreads falls back to the raw transcript for un-summarized threads", () => {
    // SUMM has a summary, RAW does not; a query matching both must still surface RAW.
    writeSession(env.projects, "-repo", "SUMM", [
      userMsg("SUMM", "u1", "knex migration in the api service", { timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo", "RAW", [
      userMsg("RAW", "u2", "another knex migration in the web service", { timestamp: ts(10) }),
    ]);
    runIndex(db);
    writeSummary(db, "SUMM", "Did a knex migration. Keywords: knex");

    const hits = relevantThreads(db, "knex migration", 3);
    const byId = new Map(hits.map((h) => [h.id, h]));
    expect(byId.get("SUMM")!.fromSummary).toBe(true);
    expect(byId.get("RAW")!.fromSummary).toBe(false);
  });

  test("relevantThreads returns nothing for an unrelated or all-stopword prompt", () => {
    writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "database migration work")]);
    runIndex(db);
    expect(relevantThreads(db, "quux zzyzx nonexistent", 3).length).toBe(0);
    expect(relevantThreads(db, "och att den vi kan", 3).length).toBe(0);
  });

  test("openingPrompt returns the first prose user turn, skipping command wrappers", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "<command-name>/clear</command-name>", { timestamp: ts(0) }),
      userMsg("S", "u2", "the real opening question", { timestamp: ts(1) }),
      assistantMsg("S", "a1", "answer", { parentUuid: "u2", timestamp: ts(2) }),
    ]);
    runIndex(db);
    expect(openingPrompt(db, "S")).toBe("the real opening question");
  });

  test("resolveSession handles exact id, unique prefix, miss, and ambiguity", () => {
    writeSession(env.projects, "-repo", "abc12345-aaaa", [userMsg("abc12345-aaaa", "u1", "a")]);
    writeSession(env.projects, "-repo", "abc99999-bbbb", [userMsg("abc99999-bbbb", "u2", "b")]);
    runIndex(db);

    expect(resolveSession(db, "abc12345-aaaa")).toBe("abc12345-aaaa");
    expect(resolveSession(db, "abc12345")).toBe("abc12345-aaaa"); // unique prefix
    expect(resolveSession(db, "zzz")).toBeNull(); // no match
    expect(() => resolveSession(db, "abc")).toThrow(/[Aa]mbiguous/); // matches both
  });

  test("stats counts threads, sessions, messages, and deleted sources", () => {
    writeSession(env.projects, "-repo", "ORIG", [
      userMsg("ORIG", "u1", "start", { timestamp: ts(0) }),
      assistantMsg("ORIG", "a1", "ok", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    writeSession(env.projects, "-repo", "RESUME", [
      userMsg("RESUME", "u2", "more", { parentUuid: "a1", timestamp: ts(2) }),
    ]);
    runIndex(db);
    const s = stats(db);
    expect(s.sessions).toBe(2);
    expect(s.threads).toBe(1); // RESUME folds into ORIG
    expect(s.messages).toBe(3);
    expect(s.deletedSources).toBe(0);
  });
});
