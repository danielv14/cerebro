import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db.ts";
import { writeSummary } from "../src/digest/index.ts";
import { runIndex } from "../src/indexer.ts";
import { decayedRank, relevantThreads } from "../src/relevance.ts";
import {
  assistantMsg,
  makeClaudeDir,
  type TempClaude,
  ts,
  userMsg,
  writeSession,
} from "./fixtures.ts";

// The ranking module's own tests: the two FTS tiers, the recency decay and the
// same-repo boost. They live next to the module rather than among the data-access
// tests they used to share a file with.
describe("relevance ranking", () => {
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

  test("decayedRank shrinks a hit's bm25 magnitude with age (#52)", () => {
    const now = Date.parse("2026-07-01T00:00:00Z");
    const fresh = decayedRank(-10, "2026-07-01T00:00:00Z", now);
    const halfLife = decayedRank(-10, "2026-04-02T00:00:00Z", now); // ~90 days old
    const unknown = decayedRank(-10, null, now);
    expect(fresh).toBeCloseTo(-10);
    expect(halfLife).toBeCloseTo(-5, 0);
    expect(fresh).toBeLessThan(halfLife); // fresher = more negative = ranked first
    expect(halfLife).toBeLessThan(unknown); // unknown activity ranks worst
  });

  test("relevantThreads prefers a recent thread over an old one at similar text relevance (#52)", () => {
    // OLD matches slightly more densely, but its last activity is half a year before
    // NEW's. Recency decay must flip the order for the injection use case.
    writeSession(env.projects, "-repo", "OLD", [
      userMsg("OLD", "u1", "the limiter limiter design", { timestamp: ts(0) }),
    ]);
    const halfYear = 180 * 86_400;
    writeSession(env.projects, "-repo", "NEW", [
      userMsg("NEW", "u2", "notes about the limiter approach", { timestamp: ts(halfYear) }),
    ]);
    runIndex(db);
    const now = Date.parse(ts(halfYear));
    const hits = relevantThreads(db, "limiter", 2, now);
    expect(hits.map((h) => h.id)).toEqual(["NEW", "OLD"]);
  });

  test("decayedRank multiplies the magnitude up for a same-repo boost (#88)", () => {
    const now = Date.parse("2026-07-01T00:00:00Z");
    const plain = decayedRank(-10, "2026-07-01T00:00:00Z", now);
    const boosted = decayedRank(-10, "2026-07-01T00:00:00Z", now, 1.5);
    expect(boosted).toBeCloseTo(plain * 1.5);
    expect(boosted).toBeLessThan(plain); // boosted = more negative = ranked first
  });

  test("relevantThreads boosts a same-repo thread over a fresher cross-repo one (#88)", () => {
    // Equal text match. OTHER is a month fresher, so it wins the global ranking; the
    // same-repo boost (worth ~2 months of recency) must flip that when the prompt was
    // typed in MINE's repo.
    const month = 30 * 86_400;
    writeSession(env.projects, "-repo-mine", "MINE", [
      userMsg("MINE", "u1", "notes about the limiter design", {
        cwd: "/repo-mine",
        timestamp: ts(0),
      }),
    ]);
    writeSession(env.projects, "-repo-other", "OTHER", [
      userMsg("OTHER", "u2", "notes about the limiter design", {
        cwd: "/repo-other",
        timestamp: ts(month),
      }),
    ]);
    runIndex(db);
    const now = Date.parse(ts(month));

    // No scope: unchanged global behavior, recency decides.
    expect(relevantThreads(db, "limiter", 2, now).map((h) => h.id)).toEqual(["OTHER", "MINE"]);
    // Scoped by the cwd's exact project path (no git root, as in these fixtures).
    expect(relevantThreads(db, "limiter", 2, now, { cwd: "/repo-mine" }).map((h) => h.id)).toEqual([
      "MINE",
      "OTHER",
    ]);
    // A cwd in neither repo boosts nothing.
    expect(
      relevantThreads(db, "limiter", 2, now, { cwd: "/repo-elsewhere" }).map((h) => h.id),
    ).toEqual(["OTHER", "MINE"]);
  });

  test("relevantThreads boosts on git_root when the cwd is inside a repo (#88)", () => {
    writeSession(env.projects, "-repo-mine", "MINE", [
      userMsg("MINE", "u1", "notes about the limiter design", {
        cwd: "/checkout/mine",
        timestamp: ts(0),
      }),
    ]);
    const month = 30 * 86_400;
    writeSession(env.projects, "-repo-other", "OTHER", [
      userMsg("OTHER", "u2", "notes about the limiter design", {
        cwd: "/checkout/other",
        timestamp: ts(month),
      }),
    ]);
    runIndex(db);
    // The fixture cwds are not real directories, so indexing resolved no git root;
    // set the roots the way an index inside a real repo would (gitInfo itself is
    // covered in git.test.ts).
    db.run("UPDATE sessions SET git_root = '/checkout/mine' WHERE session_id = 'MINE'");
    db.run("UPDATE sessions SET git_root = '/checkout/other' WHERE session_id = 'OTHER'");
    const now = Date.parse(ts(month));

    // repoRoot matches on git_root, and takes precedence over the cwd path.
    const hits = relevantThreads(db, "limiter", 2, now, {
      repoRoot: "/checkout/mine",
      cwd: "/checkout/mine/packages/api",
    });
    expect(hits.map((h) => h.id)).toEqual(["MINE", "OTHER"]);
  });

  test("relevantThreads boost is not a filter: cross-repo threads still surface (#88)", () => {
    // STRONG matches densely but sits in another repo; WEAK is a buried match in the
    // prompt's own repo. Both must come back, so shared-infrastructure work stays
    // reachable, and the boost must not be strong enough to bury the far better match.
    writeSession(env.projects, "-repo-other", "STRONG", [
      userMsg("STRONG", "u1", "limiter limiter limiter", { cwd: "/repo-other", timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo-mine", "WEAK", [
      userMsg("WEAK", "u2", `limiter ${"filler ".repeat(200)}`, {
        cwd: "/repo-mine",
        timestamp: ts(0),
      }),
    ]);
    runIndex(db);
    const hits = relevantThreads(db, "limiter", 3, Date.parse(ts(0)), { cwd: "/repo-mine" });
    expect(hits.map((h) => h.id)).toEqual(["STRONG", "WEAK"]);
  });

  test("relevantThreads applies the boost in the summary tier too (#88)", () => {
    const month = 30 * 86_400;
    writeSession(env.projects, "-repo-mine", "MINE", [
      userMsg("MINE", "u1", "some work", { cwd: "/repo-mine", timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo-other", "OTHER", [
      userMsg("OTHER", "u2", "some work", { cwd: "/repo-other", timestamp: ts(month) }),
    ]);
    runIndex(db);
    // Identical summaries: only repo and age differ, and the match is summary-only.
    writeSummary(db, "MINE", "Built the limiter middleware. Keywords: limiter");
    writeSummary(db, "OTHER", "Built the limiter middleware. Keywords: limiter");
    const now = Date.parse(ts(month));

    const global = relevantThreads(db, "limiter", 2, now);
    expect(global.map((h) => h.id)).toEqual(["OTHER", "MINE"]);
    expect(global.every((h) => h.fromSummary)).toBe(true);
    const scoped = relevantThreads(db, "limiter", 2, now, { cwd: "/repo-mine" });
    expect(scoped.map((h) => h.id)).toEqual(["MINE", "OTHER"]);
    expect(scoped.every((h) => h.fromSummary)).toBe(true);
  });

  test("relevantThreads returns nothing for an unrelated or all-stopword prompt", () => {
    writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "database migration work")]);
    runIndex(db);
    expect(relevantThreads(db, "quux zzyzx nonexistent", 3).length).toBe(0);
    expect(relevantThreads(db, "och att den vi kan", 3).length).toBe(0);
  });
});
