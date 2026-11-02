import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { openDb } from "../src/db.ts";
import { writeSummary } from "../src/digest/store.ts";
import { runIndex } from "../src/indexer.ts";
import { makeClaudeDir, type TempClaude, ts, userMsg, writeSession } from "./fixtures.ts";

const git = (cwd: string, args: string[]): void => {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
};

const initRepo = (path: string): void => {
  fs.mkdirSync(path, { recursive: true });
  git(path, ["init", "-q"]);
  git(path, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "x",
  ]);
};

const DAY = 86_400;

// Real repos rather than a fake resolver: the worktree case only holds if git's
// common dir resolves the way the key assumes.
describe("thread repo identity", () => {
  let env: TempClaude;
  let places: Record<string, string>;
  let dbPath: string;

  const cliJson = (args: string[]): { id: string; fromSummary?: boolean }[] => {
    const logs: string[] = [];
    runCli(
      args,
      { log: (line) => logs.push(line), error: () => {}, setExitCode: () => {} },
      () => openDb(dbPath),
      { adapters: env.adapters, now: Date.parse(ts(0)) },
    );
    return JSON.parse(logs.join("\n"));
  };

  beforeEach(() => {
    env = makeClaudeDir();
    const base = fs.realpathSync(env.claudeRoot);
    places = {
      MAIN: join(base, "mine"),
      WORKTREE: join(base, "mine-feature"),
      NOREMOTE: join(base, "loner"),
      NOREMOTE_WT: join(base, "loner-feature"),
      NOGIT: join(base, "plain"),
    };
    initRepo(places.MAIN!);
    git(places.MAIN!, ["remote", "add", "origin", "git@host:me/mine.git"]);
    git(places.MAIN!, ["worktree", "add", "-q", places.WORKTREE!]);
    initRepo(places.NOREMOTE!);
    git(places.NOREMOTE!, ["worktree", "add", "-q", places.NOREMOTE_WT!]);
    fs.mkdirSync(places.NOGIT!);

    // Newest first, so that without the boost no case's own threads lead the ranking.
    const order = ["NOREMOTE", "MAIN", "NOGIT", "WORKTREE", "NOREMOTE_WT"];
    order.forEach((id, age) => {
      writeSession(env.projects, `-${id}`, id, [
        userMsg(id, `u-${id}`, "notes about the limiter", {
          cwd: places[id],
          timestamp: ts(-age * DAY),
        }),
      ]);
    });
    dbPath = join(env.claudeRoot, "archive.sqlite");
    const db = openDb(dbPath);
    runIndex(db, { adapters: env.adapters });
    for (const id of order) writeSummary(db, id, "Built the throttle. Keywords: throttle");
    db.close();
  });
  afterEach(() => env.cleanup());

  const cases: { from: string; repo: string[]; name: string }[] = [
    { from: "MAIN", repo: ["MAIN", "WORKTREE"], name: "mine" },
    { from: "WORKTREE", repo: ["MAIN", "WORKTREE"], name: "mine" },
    { from: "NOREMOTE", repo: ["NOREMOTE", "NOREMOTE_WT"], name: "loner" },
    { from: "NOREMOTE_WT", repo: ["NOREMOTE", "NOREMOTE_WT"], name: "loner" },
    { from: "NOGIT", repo: ["NOGIT"], name: "plain" },
  ];

  for (const { from, repo, name } of cases) {
    test(`from ${from}: recent and both boost tiers see the same repo`, () => {
      const cwd = places[from]!;
      const recent = cliJson(["recent", "--cwd", cwd, "--days", "30", "--json"]);
      expect(recent.map((row) => row.id).sort()).toEqual(repo);

      for (const [term, fromSummary] of [
        ["limiter", false],
        ["throttle", true],
      ] as const) {
        const hits = cliJson(["relevant", "--cwd", cwd, "--limit", "5", "--json", term]);
        expect(hits.every((hit) => hit.fromSummary === fromSummary)).toBe(true);
        expect(
          hits
            .slice(0, repo.length)
            .map((hit) => hit.id)
            .sort(),
        ).toEqual(repo);
      }

      const logs: string[] = [];
      runCli(
        ["recent", "--cwd", cwd, "--days", "30"],
        { log: (line) => logs.push(line), error: () => {}, setExitCode: () => {} },
        () => openDb(dbPath),
        { adapters: env.adapters, now: Date.parse(ts(0)) },
      );
      expect(logs[0]).toBe(`Recent sessions in ${name} (last 30 days):`);
    });
  }

  test("a thread recorded before the remote was added still counts as the repo", () => {
    const repo = places.NOREMOTE!;
    fs.rmSync(dbPath);
    fs.rmSync(env.projects, { recursive: true });
    writeSession(env.projects, "-before", "BEFORE", [
      userMsg("BEFORE", "u1", "work", { cwd: repo, timestamp: ts(-DAY) }),
    ]);
    const db = openDb(dbPath);
    runIndex(db, { adapters: env.adapters });
    git(repo, ["remote", "add", "origin", "git@host:me/loner.git"]);
    writeSession(env.projects, "-after", "AFTER", [
      userMsg("AFTER", "u2", "work", { cwd: repo, timestamp: ts(0) }),
    ]);
    runIndex(db, { adapters: env.adapters });
    db.close();

    const recent = cliJson(["recent", "--cwd", repo, "--json"]);
    expect(recent.map((row) => row.id)).toEqual(["AFTER", "BEFORE"]);
  });
});
