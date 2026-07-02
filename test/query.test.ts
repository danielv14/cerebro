import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { openDb } from "../src/db.ts";
import { writeSummary } from "../src/digest.ts";
import { runIndex } from "../src/indexer.ts";
import {
  listThreads,
  recentThreads,
  relevantThreads,
  resolveSession,
  search,
  stats,
  toMatchQuery,
} from "../src/query.ts";
import {
  assistantMsg,
  makeClaudeDir,
  type TempClaude,
  ts,
  userMsg,
  writeSession,
  writeSubagent,
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

  test("search orders hits by bm25 relevance (dense match before a buried one)", () => {
    // DENSE: the term dominates a short message. BURIED: one occurrence drowned in
    // filler. bm25 ranks the dense, shorter document higher; this pins the ORDER BY
    // so a regression that drops or reverses it is caught (every other search test
    // has a single hit and would stay green regardless of ordering).
    writeSession(env.projects, "-repo", "DENSE", [
      userMsg("DENSE", "u1", "limiter limiter limiter", { timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo", "BURIED", [
      userMsg("BURIED", "u2", `limiter ${"filler ".repeat(200)}`, { timestamp: ts(10) }),
    ]);
    runIndex(db);
    const hits = search(db, "limiter", 10);
    expect(hits.map((h) => h.session_id)).toEqual(["DENSE", "BURIED"]);
  });

  test("search caps results at the limit, keeping the most relevant", () => {
    writeSession(env.projects, "-repo", "TOP", [
      userMsg("TOP", "u1", "limiter limiter limiter", { timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo", "MID", [
      userMsg("MID", "u2", `limiter ${"filler ".repeat(100)}`, { timestamp: ts(10) }),
    ]);
    writeSession(env.projects, "-repo", "LOW", [
      userMsg("LOW", "u3", `limiter ${"filler ".repeat(400)}`, { timestamp: ts(20) }),
    ]);
    runIndex(db);
    const hits = search(db, "limiter", 2);
    // Three documents match, but limit=2 truncates to the two best by bm25.
    expect(hits.map((h) => h.session_id)).toEqual(["TOP", "MID"]);
  });

  test("search returns the best hit per thread by default, --all returns every message (#53)", () => {
    writeSession(env.projects, "-repo", "CHATTY", [
      userMsg("CHATTY", "u1", "limiter limiter limiter", { timestamp: ts(0) }),
      assistantMsg("CHATTY", "a1", "limiter limiter", { parentUuid: "u1", timestamp: ts(1) }),
      userMsg("CHATTY", "u2", "more about the limiter", { parentUuid: "a1", timestamp: ts(2) }),
    ]);
    writeSession(env.projects, "-repo", "OTHER", [
      userMsg("OTHER", "u3", `limiter ${"filler ".repeat(50)}`, { timestamp: ts(10) }),
    ]);
    runIndex(db);
    // Default: one (best) hit per thread, so OTHER is not buried by CHATTY.
    const deduped = search(db, "limiter", 10);
    expect(deduped.map((h) => h.session_id).sort()).toEqual(["CHATTY", "OTHER"]);
    // --all: every matching message.
    const all = search(db, "limiter", 10, { all: true });
    expect(all.length).toBe(4);
  });

  test("search --project and --since scope the hits (#53)", () => {
    writeSession(env.projects, "-repo-a", "A", [
      userMsg("A", "u1", "limiter in alpha", { cwd: "/home/user/alpha", timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo-b", "B", [
      userMsg("B", "u2", "limiter in beta", { cwd: "/home/user/beta", timestamp: ts(100) }),
    ]);
    runIndex(db);
    expect(search(db, "limiter", 10, { project: "alpha" }).map((h) => h.session_id)).toEqual(["A"]);
    expect(search(db, "limiter", 10, { since: ts(50) }).map((h) => h.session_id)).toEqual(["B"]);
    expect(search(db, "limiter", 10).length).toBe(2);
  });

  test("search hits carry the thread ordinal matching show's numbering (#58)", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "opening prompt", { timestamp: ts(0) }),
      assistantMsg("S", "a1", "the limiter answer", { parentUuid: "u1", timestamp: ts(1) }),
      userMsg("S", "u2", "closing note", { parentUuid: "a1", timestamp: ts(2) }),
    ]);
    runIndex(db);
    const hits = search(db, "limiter", 10);
    expect(hits.length).toBe(1);
    expect(hits[0]!.ordinal).toBe(2); // second message in the thread's chronology
  });

  test("search recovers from a malformed FTS query via the sanitized fallback", () => {
    // A bare unbalanced quote is invalid FTS5 (`unterminated string`) and throws on
    // the verbatim MATCH. The catch re-runs the query as a sanitized phrase of the
    // bare tokens, so a fat-fingered query still returns its hit instead of erroring.
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "alpha beta gamma", { timestamp: ts(0) }),
    ]);
    runIndex(db);
    const hits = search(db, 'alpha"', 10);
    expect(hits.map((h) => h.session_id)).toEqual(["S"]);
  });

  test("search returns no hits when a malformed query sanitizes to nothing matchable", () => {
    // The fallback must also fail soft: a punctuation-only query throws on the raw
    // MATCH, sanitizes to a phrase with no tokens, and yields [] rather than throwing.
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "alpha beta", { timestamp: ts(0) }),
    ]);
    runIndex(db);
    expect(search(db, '"""', 10)).toEqual([]);
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

  test("the threads view rolls up root + resume + subagent with root-preferring fields", () => {
    // Root: has a title and project_path. Resume: NULL title, different project_path,
    // and we delete its file so its body_available drops to 0. Subagent: folds into
    // the root's session id (does not add a sessions row).
    writeSession(env.projects, "-repo-root", "ROOT", [
      userMsg("ROOT", "u1", "start", {
        cwd: "/repo-root",
        timestamp: ts(0),
      }),
      assistantMsg("ROOT", "a1", "ok", {
        cwd: "/repo-root",
        parentUuid: "u1",
        timestamp: ts(1),
      }),
      // A summary line gives the root a title (priority 1).
      { type: "summary", summary: "Root title", leafUuid: "a1" },
    ]);
    const resumePath = writeSession(env.projects, "-repo-resume", "RESUME", [
      userMsg("RESUME", "u2", "more", {
        cwd: "/repo-resume",
        parentUuid: "a1",
        timestamp: ts(2),
      }),
    ]);
    writeSubagent(env.projects, "-repo-root", "ROOT", "agent-1", [
      userMsg("ROOT", "su1", "subagent prompt", {
        cwd: "/repo-root",
        isSidechain: true,
        timestamp: ts(3),
      }),
      assistantMsg("ROOT", "sa1", "subagent reply", {
        cwd: "/repo-root",
        isSidechain: true,
        parentUuid: "su1",
        timestamp: ts(4),
      }),
    ]);
    runIndex(db);
    // Drop the resume's source file so a re-index marks its body unavailable.
    fs.rmSync(resumePath);
    runIndex(db);

    const thread = db
      .query(
        `SELECT id, last_ts, first_ts, msgs, sessions_in_thread, project_path, title, body_available
         FROM threads WHERE id = ?`,
      )
      .get("ROOT") as {
      id: string;
      last_ts: string;
      first_ts: string;
      msgs: number;
      sessions_in_thread: number;
      project_path: string;
      title: string | null;
      body_available: number;
    };

    expect(thread.id).toBe("ROOT");
    // Root-preferring: title and project_path come from the root, not the resume.
    expect(thread.title).toBe("Root title");
    expect(thread.project_path).toBe("/repo-root");
    // msgs is the sum across root (2) + resume (1) + folded subagent (2).
    expect(thread.msgs).toBe(5);
    // ROOT and RESUME are sessions rows; the subagent folds into ROOT.
    expect(thread.sessions_in_thread).toBe(2);
    // MIN: RESUME's body is unavailable (file deleted), so the thread is too.
    expect(thread.body_available).toBe(0);
    // Span covers the whole thread.
    expect(thread.first_ts).toBe(ts(0));
    expect(thread.last_ts).toBe(ts(4));
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

  test("resolveSession handles exact id, unique prefix, miss, and ambiguity", () => {
    writeSession(env.projects, "-repo", "abc12345-aaaa", [userMsg("abc12345-aaaa", "u1", "a")]);
    writeSession(env.projects, "-repo", "abc99999-bbbb", [userMsg("abc99999-bbbb", "u2", "b")]);
    runIndex(db);

    expect(resolveSession(db, "abc12345-aaaa")).toBe("abc12345-aaaa");
    expect(resolveSession(db, "abc12345")).toBe("abc12345-aaaa"); // unique prefix
    expect(resolveSession(db, "zzz")).toBeNull(); // no match
    expect(() => resolveSession(db, "abc")).toThrow(/[Aa]mbiguous/); // matches both
  });

  test("resolveSession treats LIKE wildcards in a prefix literally (#48)", () => {
    writeSession(env.projects, "-repo", "abc12345-aaaa", [userMsg("abc12345-aaaa", "u1", "a")]);
    runIndex(db);
    // `_` would match any character unescaped; `%` would match everything.
    expect(resolveSession(db, "abc_2345")).toBeNull();
    expect(resolveSession(db, "%")).toBeNull();
  });

  test("--project filter treats LIKE wildcards literally (#48)", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "hi", { cwd: "/home/user/myXapp" }),
    ]);
    runIndex(db);
    // Unescaped, `my_app` would match `myXapp` via the `_` wildcard.
    expect(listThreads(db, { project: "my_app" }).length).toBe(0);
    expect(listThreads(db, { project: "myXapp" }).length).toBe(1);
  });

  test("stats excludes subagent-only stubs from deleted sources (#45)", () => {
    // A parent stub created purely from a subagent file: source_file is NULL,
    // body_available becomes 0, but nothing was ever deleted.
    writeSubagent(env.projects, "-repo", "STUB", "agent-1", [
      userMsg("STUB", "sa1", "sub work", { isSidechain: true }),
    ]);
    const path = writeSession(env.projects, "-repo", "REAL", [userMsg("REAL", "u1", "hi")]);
    runIndex(db);
    expect(stats(db).deletedSources).toBe(0);
    // A genuinely deleted source still counts.
    fs.rmSync(path);
    runIndex(db);
    expect(stats(db).deletedSources).toBe(1);
  });

  test("stats counts threads, sessions, messages, and deleted sources", () => {
    writeSession(env.projects, "-repo", "ORIG", [
      userMsg("ORIG", "u1", "start", { timestamp: ts(0) }),
      assistantMsg("ORIG", "a1", "ok", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    writeSession(env.projects, "-repo", "RESUME", [
      userMsg("RESUME", "u2", "more", { parentUuid: "a1", timestamp: ts(2) }),
    ]);
    // A second, independent thread so the thread count is exercised above one.
    writeSession(env.projects, "-repo", "OTHER", [
      userMsg("OTHER", "u3", "another", { timestamp: ts(3) }),
    ]);
    runIndex(db);
    const s = stats(db);
    expect(s.sessions).toBe(3);
    expect(s.threads).toBe(2); // RESUME folds into ORIG; OTHER is its own thread
    expect(s.messages).toBe(4);
    expect(s.deletedSources).toBe(0);
  });
});
