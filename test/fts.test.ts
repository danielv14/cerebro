import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db.ts";
import { bestHitPerRoot, dedupedHitWindow } from "../src/fts.ts";
import { runIndex } from "../src/indexer.ts";
import { relevantThreads } from "../src/relevance.ts";
import { search } from "../src/search.ts";
import {
  countHitQueries,
  makeClaudeDir,
  type TempClaude,
  ts,
  userMsg,
  writeSession,
} from "./fixtures.ts";

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

describe("dedupedHitWindow", () => {
  // A fetch that serves the top `size` rows of a fixed ranked list and records the
  // window sizes it was asked for, so a test can pin the number of rounds.
  const fetcher = (rows: { root: string }[], asked: number[]) => (size: number) => {
    asked.push(size);
    return rows.slice(0, size);
  };

  const chatty = (roots: number, perRoot: number): { root: string }[] =>
    Array.from({ length: roots }, (_, r) =>
      Array.from({ length: perRoot }, () => ({ root: `R${r}` })),
    ).flat();

  test("stops after one fetch when the first window already holds the target", () => {
    const asked: number[] = [];
    const kept = dedupedHitWindow({
      fetch: fetcher(chatty(8, 10), asked),
      target: 3,
      firstWindow: 80,
    });
    expect(asked).toEqual([80]);
    expect(kept).toHaveLength(8);
  });

  test("grows geometrically until the window holds the target roots", () => {
    const asked: number[] = [];
    const kept = dedupedHitWindow({
      fetch: fetcher(chatty(20, 10), asked),
      target: 16,
      firstWindow: 10,
    });
    // Ten rows per root, so 10 rows hold 1 root, 40 hold 4, and 160 hold the 16 asked
    // for. Without the growth the answer would have been that first single root.
    expect(asked).toEqual([10, 40, 160]);
    expect(kept).toHaveLength(16);
  });

  test("caps the growth rounds rather than fetching forever", () => {
    const asked: number[] = [];
    // One root owns every row, so the target is never reachable.
    dedupedHitWindow({ fetch: fetcher(chatty(1, 100_000), asked), target: 5, firstWindow: 10 });
    expect(asked).toEqual([10, 40, 160, 640]);
  });

  test("stops when a partial window proves there are no deeper rows", () => {
    const asked: number[] = [];
    dedupedHitWindow({ fetch: fetcher(chatty(2, 10), asked), target: 5, firstWindow: 80 });
    expect(asked).toEqual([80]);
  });

  test("keeps the best hit per root under the caller's rank", () => {
    const rows = [
      { root: "A", tag: "a-worse", rank: 5 },
      { root: "B", tag: "b", rank: 3 },
      { root: "A", tag: "a-best", rank: 1 },
    ];
    const kept = dedupedHitWindow({
      fetch: () => rows,
      target: 2,
      firstWindow: 10,
      rank: (hit) => hit.rank,
    });
    expect(kept.map((hit) => hit.tag)).toEqual(["a-best", "b"]);
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

  test("relevant fills its limit when chatty threads dominate the raw tier (#141)", () => {
    // 20 threads with 10 equally matching turns each. The raw tier used to ask for a
    // flat 80 rows, so eight chatty threads owned the whole window and --limit 20
    // came back with 8. The window now grows off the caller's limit.
    for (let thread = 0; thread < 20; thread++) {
      const id = `T${thread}`;
      writeSession(
        env.projects,
        "-repo",
        id,
        Array.from({ length: 10 }, (_, turn) =>
          userMsg(id, `${id}-m${turn}`, "limiter limiter limiter", {
            timestamp: ts(thread * 100 + turn),
            parentUuid: turn === 0 ? null : `${id}-m${turn - 1}`,
          }),
        ),
      );
    }
    runIndex(db);

    expect(relevantThreads(db, "limiter", 20)).toHaveLength(20);
    // The default limit stays on a single fetch: `relevant` runs on the prompt
    // hook's latency path, and 80 rows already hold far more than 3 threads.
    let hits = 0;
    const queries = countHitQueries(db, () => {
      hits = relevantThreads(db, "limiter", 3).length;
    });
    expect(hits).toBe(3);
    expect(queries).toBe(1);
  });
});
