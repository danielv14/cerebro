import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db.ts";
import { runIndex } from "../src/indexer.ts";
import { relevantThreads } from "../src/relevance.ts";
import { search } from "../src/search.ts";
import {
  countQueriesMatching,
  makeClaudeDir,
  type TempClaude,
  ts,
  userMsg,
  writeSession,
} from "./fixtures.ts";

describe("search and relevant agree on thread rollup metadata (#119/#127)", () => {
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

  test("a thread with metadata split across root and resume shows one project and title", () => {
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
    runIndex(db, { adapters: env.adapters });

    const searchHits = search(db, "capacitor", 10);
    expect(searchHits).toHaveLength(1);

    const relevantHits = relevantThreads(db, "flux capacitor", 3);
    expect(relevantHits).toHaveLength(1);
    expect(relevantHits[0]!.id).toBe("ROOT");

    expect(searchHits[0]!.project_path).toBe("/home/user/alpha");
    expect(relevantHits[0]!.project_path).toBe("/home/user/alpha");
    expect(searchHits[0]!.title).toBe("Flux capacitor tuning");
    expect(relevantHits[0]!.title).toBe("Flux capacitor tuning");
  });

  test("relevant fills its limit when chatty threads dominate the raw tier (#141)", () => {
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
    runIndex(db, { adapters: env.adapters });

    expect(relevantThreads(db, "limiter", 20)).toHaveLength(20);
  });

  test("relevant stays on one fetch at its default limit (#141)", () => {
    // CHATTY matches strongly 200 times, so it owns the whole first 80-row window and BURIED only
    // surfaces from a deeper fetch.
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
    runIndex(db, { adapters: env.adapters });

    let threads: string[] = [];
    const queries = countQueriesMatching(db, "messages_fts MATCH", () => {
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
