import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db.ts";
import { dedupedHitWindow } from "../src/fts.ts";
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

describe("dedupedHitWindow", () => {
  // A fetch that serves the top `size` rows of a fixed ranked list and records the
  // window sizes it was asked for, so a test can pin the number of rounds.
  const fetcher = (rows: { root: string }[], asked: number[]) => (size: number) => {
    asked.push(size);
    return rows.slice(0, size);
  };

  // `roots` threads with `perRoot` matching rows each, worst hit last, which is the
  // shape a chatty thread makes in a ranked window.
  const chatty = (roots: number, perRoot: number): { root: string }[] =>
    Array.from({ length: roots }, (_, root) =>
      Array.from({ length: perRoot }, () => ({ root: `R${root}` })),
    ).flat();

  test("sizes the first fetch off the target root count, floored at minRows", () => {
    const asked: number[] = [];
    const spec = { fetch: fetcher(chatty(40, 1), asked), minRows: 80, rowsPerRoot: 20 };
    dedupedHitWindow({ ...spec, targetRoots: 3 });
    dedupedHitWindow({ ...spec, targetRoots: 20 });
    // 3 * 20 is under the floor, 20 * 20 is over it.
    expect(asked).toEqual([80, 400]);
  });

  test("keeps the first hit per root in the incoming order by default", () => {
    const rows = [
      { root: "A", tag: "a1" },
      { root: "B", tag: "b1" },
      { root: "A", tag: "a2" },
      { root: "C", tag: "c1" },
    ];
    const kept = dedupedHitWindow({
      fetch: () => rows,
      targetRoots: 3,
      minRows: 10,
      rowsPerRoot: 1,
    });
    expect(kept.map((hit) => hit.tag)).toEqual(["a1", "b1", "c1"]);
  });

  test("keeps the lowest-ranked hit per root and returns them best-first", () => {
    const rows = [
      { root: "A", tag: "a-worse", rank: 5 },
      { root: "B", tag: "b", rank: 3 },
      { root: "A", tag: "a-best", rank: 1 },
    ];
    const kept = dedupedHitWindow({
      fetch: () => rows,
      targetRoots: 2,
      minRows: 10,
      rowsPerRoot: 1,
      rank: (hit) => hit.rank,
    });
    expect(kept.map((hit) => hit.tag)).toEqual(["a-best", "b"]);
  });

  test("stops after one fetch when the first window already holds the target", () => {
    const asked: number[] = [];
    const kept = dedupedHitWindow({
      fetch: fetcher(chatty(8, 10), asked),
      targetRoots: 3,
      minRows: 80,
      rowsPerRoot: 20,
    });
    expect(asked).toEqual([80]);
    expect(kept).toHaveLength(8);
  });

  test("grows geometrically until the window holds the target roots", () => {
    const asked: number[] = [];
    const kept = dedupedHitWindow({
      fetch: fetcher(chatty(20, 10), asked),
      targetRoots: 10,
      minRows: 10,
      rowsPerRoot: 1,
    });
    // Ten rows per root, so 10 rows hold 1 root, 40 hold 4, and 160 hold 16, past the
    // 10 asked for. Without the growth the answer would have been that single root.
    expect(asked).toEqual([10, 40, 160]);
    expect(kept).toHaveLength(16);
  });

  test("caps the growth rounds rather than fetching forever", () => {
    const asked: number[] = [];
    // One root owns every row, so the target is never reachable.
    dedupedHitWindow({
      fetch: fetcher(chatty(1, 100_000), asked),
      targetRoots: 5,
      minRows: 10,
      rowsPerRoot: 1,
    });
    expect(asked).toEqual([10, 40, 160, 640]);
  });

  test("stops when a partial window proves there are no deeper rows", () => {
    const asked: number[] = [];
    dedupedHitWindow({
      fetch: fetcher(chatty(2, 10), asked),
      targetRoots: 5,
      minRows: 80,
      rowsPerRoot: 1,
    });
    expect(asked).toEqual([80]);
  });

  test("answers out of the first fetch when the caller turns growth off", () => {
    const asked: number[] = [];
    // Exactly 80 rows over 2 roots: a full window holding fewer roots than asked for,
    // which is the one shape that sends the growth rounds off. The latency-path caller
    // takes the two it found instead.
    const kept = dedupedHitWindow({
      fetch: fetcher(chatty(2, 40), asked),
      targetRoots: 5,
      minRows: 80,
      rowsPerRoot: 1,
      grow: false,
    });
    expect(asked).toEqual([80]);
    expect(kept).toHaveLength(2);
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
    // answered with 8. The window now grows off the caller's limit.
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
  });

  test("relevant stays on one fetch at its default limit (#141)", () => {
    // CHATTY matches strongly 200 times, so it owns the whole first 80-row window and
    // BURIED only surfaces from a deeper fetch. At the default limit `relevant` runs
    // on the prompt hook's latency path and declines to pay for that: one query, and
    // the thread those 80 rows held. Ask for more than the default and the growth
    // rounds are back, which is the trade made explicit.
    writeSession(
      env.projects,
      "-repo",
      "CHATTY",
      Array.from({ length: 200 }, (_, turn) =>
        userMsg("CHATTY", `c${turn}`, "limiter limiter limiter", {
          timestamp: ts(turn),
          parentUuid: turn === 0 ? null : `c${turn - 1}`,
        }),
      ),
    );
    writeSession(env.projects, "-repo", "BURIED", [
      userMsg("BURIED", "b1", `limiter ${"filler ".repeat(80)}`, { timestamp: ts(1000) }),
    ]);
    runIndex(db);

    let threads: string[] = [];
    const queries = countHitQueries(db, () => {
      threads = relevantThreads(db, "limiter").map((thread) => thread.id);
    });
    expect(threads).toEqual(["CHATTY"]);
    expect(queries).toBe(1);

    expect(
      relevantThreads(db, "limiter", 4)
        .map((thread) => thread.id)
        .sort(),
    ).toEqual(["BURIED", "CHATTY"]);
  });
});
