import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db.ts";
import { bestHitPerRoot } from "../src/fts.ts";
import { runIndex } from "../src/indexer.ts";
import { relevantThreads } from "../src/relevance.ts";
import { search } from "../src/search.ts";
import { makeClaudeDir, type TempClaude, ts, userMsg, writeSession } from "./fixtures.ts";

describe("bestHitPerRoot", () => {
  const hit = (root: string, tag: string): { root: string; tag: string } => ({ root, tag });

  test("keeps the first hit per root in the incoming order by default", () => {
    const kept = bestHitPerRoot([hit("A", "a1"), hit("B", "b1"), hit("A", "a2"), hit("C", "c1")]);
    expect(kept.map((h) => h.tag)).toEqual(["a1", "b1", "c1"]);
  });

  test("keeps the lowest-ranked hit per root and returns them best-first", () => {
    const ranked = [
      { root: "A", tag: "a-worse", rank: 5 },
      { root: "B", tag: "b", rank: 3 },
      { root: "A", tag: "a-best", rank: 1 },
    ];
    const kept = bestHitPerRoot(ranked, (h) => h.rank);
    expect(kept.map((h) => h.tag)).toEqual(["a-best", "b"]);
  });
});

describe("search and relevant agree on thread rollup metadata (#119/#127)", () => {
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

  test("a thread with metadata split across root and resume shows one project and title", () => {
    // The bug class this pins: a resumed thread whose root carries the cwd (and no
    // title) while the resume carries the title (and no cwd). When search and
    // relevance each owned their own copy of the FTS join, one path read the
    // session row and the other the rollup, and the same thread rendered with two
    // different projects/titles. Both paths now go through rankedMessageHits plus
    // the same rollup hydration, so the metadata must be identical.
    writeSession(env.projects, "-repo", "ROOT", [
      userMsg("ROOT", "u1", "started the flux capacitor work", {
        cwd: "/home/user/alpha",
        timestamp: ts(0),
      }),
    ]);
    writeSession(env.projects, "-repo", "RESUME", [
      { type: "custom-title", customTitle: "Flux capacitor tuning", sessionId: "RESUME" },
      userMsg("RESUME", "u2", "more flux capacitor tuning", {
        cwd: undefined,
        parentUuid: "u1",
        timestamp: ts(10),
      }),
    ]);
    runIndex(db);

    const searchHits = search(db, "capacitor", 10);
    expect(searchHits).toHaveLength(1);

    const relevantHits = relevantThreads(db, "flux capacitor", 3);
    expect(relevantHits).toHaveLength(1);
    expect(relevantHits[0]!.id).toBe("ROOT");

    // The same thread resolves to the same rollup metadata through both paths.
    expect(searchHits[0]!.project_path).toBe("/home/user/alpha");
    expect(relevantHits[0]!.project_path).toBe("/home/user/alpha");
    expect(searchHits[0]!.title).toBe("Flux capacitor tuning");
    expect(relevantHits[0]!.title).toBe("Flux capacitor tuning");
  });
});
