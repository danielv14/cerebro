import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db.ts";
import { writeSummary } from "../src/digest/store.ts";
import type { GitResolver } from "../src/git.ts";
import { runIndex } from "../src/indexer.ts";
import { decayedRank, dedupedHitWindow, relevantThreads } from "../src/relevance.ts";
import {
  assistantMsg,
  makeClaudeDir,
  type TempClaude,
  ts,
  userMsg,
  writeSession,
} from "./fixtures.ts";

describe("relevance ranking", () => {
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

  test("relevantThreads finds threads by prompt, with opening prompt and snippet", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "migrate the database layer from drizzle to knex"),
      assistantMsg("S", "a1", "done, the knex migration is complete", { parentUuid: "u1" }),
    ]);
    runIndex(db, { adapters: env.adapters });

    const hits = relevantThreads(db, "how did the knex migration go", 3);
    expect(hits.length).toBe(1);
    expect(hits[0]!.id).toBe("S");
    expect(hits[0]!.opening).toContain("drizzle to knex");
    expect(hits[0]!.snippet.toLowerCase()).toContain("knex");
  });

  test("relevantThreads carries the thread's provider and model", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "migrate the database layer from drizzle to knex"),
      {
        ...assistantMsg("S", "a1", "the knex migration is done", { parentUuid: "u1" }),
        message: { role: "assistant", content: "the knex migration is done", model: "opus-test" },
      },
    ]);
    runIndex(db, { adapters: env.adapters });

    const [hit] = relevantThreads(db, "knex migration", 3);
    expect(hit!.provider).toBe("claude-code");
    expect(hit!.model).toBe("opus-test");
  });

  test("relevantThreads prefers a thread's summary snippet over the raw transcript", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "migrate the database layer from drizzle to knex"),
      assistantMsg("S", "a1", "done, the knex migration is complete", { parentUuid: "u1" }),
    ]);
    runIndex(db, { adapters: env.adapters });
    // "Refactored" appears only in the summary, never in the raw transcript.
    writeSummary(db, "S", "Refactored to knex");

    const hits = relevantThreads(db, "knex", 3);
    expect(hits.length).toBe(1);
    expect(hits[0]!.id).toBe("S");
    expect(hits[0]!.fromSummary).toBe(true);
    expect(hits[0]!.snippet).toContain("Refactored");
    expect(hits[0]!.snippet).toContain("[knex]");
  });

  test("relevantThreads falls back to the raw transcript for un-summarized threads", () => {
    writeSession(env.projects, "-repo", "SUMM", [
      userMsg("SUMM", "u1", "knex migration in the api service", { timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo", "RAW", [
      userMsg("RAW", "u2", "another knex migration in the web service", { timestamp: ts(10) }),
    ]);
    runIndex(db, { adapters: env.adapters });
    writeSummary(db, "SUMM", "Did a knex migration. Keywords: knex");

    const hits = relevantThreads(db, "knex migration", 3);
    const byId = new Map(hits.map((h) => [h.id, h]));
    expect(byId.get("SUMM")!.fromSummary).toBe(true);
    expect(byId.get("RAW")!.fromSummary).toBe(false);
  });

  test("decayedRank shrinks a hit's bm25 magnitude with age (#52)", () => {
    const now = Date.parse("2026-07-01T00:00:00Z");
    const fresh = decayedRank(-10, "2026-07-01T00:00:00Z", now);
    const halfLife = decayedRank(-10, "2026-04-02T00:00:00Z", now);
    const unknown = decayedRank(-10, null, now);
    expect(fresh).toBeCloseTo(-10);
    expect(halfLife).toBeCloseTo(-5, 0);
    expect(fresh).toBeLessThan(halfLife); // fresher = more negative = ranked first
    expect(halfLife).toBeLessThan(unknown);
  });

  test("relevantThreads prefers a recent thread over an old one at similar text relevance (#52)", () => {
    // OLD matches slightly more densely, but its last activity is half a year before NEW's.
    writeSession(env.projects, "-repo", "OLD", [
      userMsg("OLD", "u1", "the limiter limiter design", { timestamp: ts(0) }),
    ]);
    const halfYear = 180 * 86_400;
    writeSession(env.projects, "-repo", "NEW", [
      userMsg("NEW", "u2", "notes about the limiter approach", { timestamp: ts(halfYear) }),
    ]);
    runIndex(db, { adapters: env.adapters });
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
    runIndex(db, { adapters: env.adapters });
    const now = Date.parse(ts(month));

    expect(relevantThreads(db, "limiter", 2, now).map((h) => h.id)).toEqual(["OTHER", "MINE"]);
    expect(relevantThreads(db, "limiter", 2, now, { cwd: "/repo-mine" }).map((h) => h.id)).toEqual([
      "MINE",
      "OTHER",
    ]);
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
    // The fixture cwds are not real directories, so a fake resolver stands in for an index run
    // inside a real repo.
    const resolveGit: GitResolver = (cwd) => ({ root: cwd ?? null, remote: null });
    runIndex(db, { adapters: env.adapters, resolveGit });
    const now = Date.parse(ts(month));

    const hits = relevantThreads(db, "limiter", 2, now, {
      repoRoot: "/checkout/mine",
      cwd: "/checkout/mine/packages/api",
    });
    expect(hits.map((h) => h.id)).toEqual(["MINE", "OTHER"]);
  });

  test("relevantThreads boost is not a filter: cross-repo threads still surface (#88)", () => {
    writeSession(env.projects, "-repo-other", "STRONG", [
      userMsg("STRONG", "u1", "limiter limiter limiter", { cwd: "/repo-other", timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo-mine", "WEAK", [
      userMsg("WEAK", "u2", `limiter ${"filler ".repeat(200)}`, {
        cwd: "/repo-mine",
        timestamp: ts(0),
      }),
    ]);
    runIndex(db, { adapters: env.adapters });
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
    runIndex(db, { adapters: env.adapters });
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
    runIndex(db, { adapters: env.adapters });
    expect(relevantThreads(db, "quux zzyzx nonexistent", 3).length).toBe(0);
    expect(relevantThreads(db, "och att den vi kan", 3).length).toBe(0);
  });
});

describe("dedupedHitWindow", () => {
  const fetcher = (rows: { id: string }[], asked: number[]) => (size: number) => {
    asked.push(size);
    return rows.slice(0, size);
  };

  const chatty = (roots: number, perRoot: number): { id: string }[] =>
    Array.from({ length: roots }, (_, root) =>
      Array.from({ length: perRoot }, () => ({ id: `R${root}` })),
    ).flat();

  test("sizes the first fetch off the target root count, floored at minRows", () => {
    const asked: number[] = [];
    const spec = {
      fetch: fetcher(chatty(40, 1), asked),
      minRows: 80,
      rowsPerThread: 20,
      rank: () => 0,
    };
    dedupedHitWindow({ ...spec, targetThreads: 3 });
    dedupedHitWindow({ ...spec, targetThreads: 20 });
    // 3 * 20 is under the floor, 20 * 20 is over it.
    expect(asked).toEqual([80, 400]);
  });

  test("keeps the lowest-ranked hit per root and returns them best-first", () => {
    const rows = [
      { id: "A", tag: "a-worse", rank: 5 },
      { id: "B", tag: "b", rank: 3 },
      { id: "A", tag: "a-best", rank: 1 },
    ];
    const kept = dedupedHitWindow({
      fetch: () => rows,
      targetThreads: 2,
      minRows: 10,
      rowsPerThread: 1,
      rank: (hit) => hit.rank,
    });
    expect(kept.map((hit) => hit.tag)).toEqual(["a-best", "b"]);
  });

  test("stops after one fetch when the first window already holds the target", () => {
    const asked: number[] = [];
    const kept = dedupedHitWindow({
      fetch: fetcher(chatty(8, 10), asked),
      targetThreads: 3,
      minRows: 80,
      rowsPerThread: 20,
      rank: () => 0,
    });
    expect(asked).toEqual([80]);
    expect(kept).toHaveLength(8);
  });

  test("grows geometrically until the window holds the target roots", () => {
    const asked: number[] = [];
    const kept = dedupedHitWindow({
      fetch: fetcher(chatty(20, 10), asked),
      targetThreads: 10,
      minRows: 10,
      rowsPerThread: 1,
      rank: () => 0,
    });
    // Ten rows per root, so 10 rows hold 1 root, 40 hold 4, and 160 hold 16, past the 10 asked for.
    expect(asked).toEqual([10, 40, 160]);
    expect(kept).toHaveLength(16);
  });

  test("caps the growth rounds rather than fetching forever", () => {
    const asked: number[] = [];
    dedupedHitWindow({
      fetch: fetcher(chatty(1, 100_000), asked),
      targetThreads: 5,
      minRows: 10,
      rowsPerThread: 1,
      rank: () => 0,
    });
    expect(asked).toEqual([10, 40, 160, 640]);
  });

  test("stops when a partial window proves there are no deeper rows", () => {
    const asked: number[] = [];
    dedupedHitWindow({
      fetch: fetcher(chatty(2, 10), asked),
      targetThreads: 5,
      minRows: 80,
      rowsPerThread: 1,
      rank: () => 0,
    });
    expect(asked).toEqual([80]);
  });

  test("answers out of the first fetch when the caller turns growth off", () => {
    const asked: number[] = [];
    // Exactly 80 rows over 2 roots: a full window holding fewer roots than asked for, which is the
    // one shape that sends the growth rounds off.
    const kept = dedupedHitWindow({
      fetch: fetcher(chatty(2, 40), asked),
      targetThreads: 5,
      minRows: 80,
      rowsPerThread: 1,
      grow: false,
      rank: () => 0,
    });
    expect(asked).toEqual([80]);
    expect(kept).toHaveLength(2);
  });
});
