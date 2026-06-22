import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";
import { discoverSessionFiles } from "../src/paths.ts";
import {
  makeClaudeDir,
  type TempClaude,
  userMsg,
  writeSession,
  writeSubagent,
} from "./fixtures.ts";

// discoverSessionFiles walks CEREBRO_CLAUDE_DIR/projects. These tests pin its two
// load-bearing behaviours that the indexer tests only exercise transitively:
// invariant #3 (oldest-first by mtime, tiebreak sessionId) and the subagent walk.
describe("discoverSessionFiles", () => {
  let env: TempClaude;

  beforeEach(() => {
    env = makeClaudeDir();
    process.env.CEREBRO_CLAUDE_DIR = env.claudeRoot;
  });
  afterEach(() => env.cleanup());

  // Force a file's mtime so ordering is deterministic (real runs differ by ms).
  const setMtime = (path: string, secondsFromEpoch: number): void => {
    const when = new Date(secondsFromEpoch * 1000);
    fs.utimesSync(path, when, when);
  };

  const oneMsg = (sessionId: string) => [userMsg(sessionId, "u1", "work")];

  test("returns files oldest-first by mtime", () => {
    const a = writeSession(env.projects, "-repo", "AAA", oneMsg("AAA"));
    const b = writeSession(env.projects, "-repo", "BBB", oneMsg("BBB"));
    const c = writeSession(env.projects, "-repo", "CCC", oneMsg("CCC"));
    // Set mtimes out of filename order: B oldest, then C, then A.
    setMtime(a, 1_700_000_300);
    setMtime(b, 1_700_000_100);
    setMtime(c, 1_700_000_200);

    const files = discoverSessionFiles();
    expect(files.map((f) => f.sessionId)).toEqual(["BBB", "CCC", "AAA"]);
  });

  test("breaks an mtime tie by sessionId ascending", () => {
    const z = writeSession(env.projects, "-repo", "zzz", oneMsg("zzz"));
    const a = writeSession(env.projects, "-repo", "aaa", oneMsg("aaa"));
    const m = writeSession(env.projects, "-repo", "mmm", oneMsg("mmm"));
    // Identical mtime on all three: only the sessionId tiebreak orders them.
    const same = 1_700_000_000;
    setMtime(z, same);
    setMtime(a, same);
    setMtime(m, same);

    const files = discoverSessionFiles();
    expect(files.map((f) => f.sessionId)).toEqual(["aaa", "mmm", "zzz"]);
  });

  test("discovers subagent transcripts and attributes them to the parent session", () => {
    writeSession(env.projects, "-repo", "PARENT", oneMsg("PARENT"));
    writeSubagent(env.projects, "-repo", "PARENT", "agent-1", [
      userMsg("PARENT", "s1", "sidechain turn", { isSidechain: true }),
    ]);

    const files = discoverSessionFiles();
    const top = files.find((f) => f.kind === "session");
    const sub = files.find((f) => f.kind === "subagent");

    expect(top).toBeDefined();
    expect(top!.sessionId).toBe("PARENT");
    expect(sub).toBeDefined();
    // The subagent's owning session is the enclosing <uuid> directory (the parent),
    // so its turns fold into the parent thread.
    expect(sub!.sessionId).toBe("PARENT");
    expect(sub!.path.endsWith(join("PARENT", "subagents", "agent-1.jsonl"))).toBe(true);
  });

  test("skips non-jsonl entries and a project dir with no session files", () => {
    writeSession(env.projects, "-repo", "REAL", oneMsg("REAL"));
    // A non-jsonl file alongside, and an empty extra project dir.
    fs.writeFileSync(join(env.projects, "-repo", "notes.txt"), "ignore me");
    fs.mkdirSync(join(env.projects, "-empty"), { recursive: true });

    const files = discoverSessionFiles();
    expect(files.map((f) => f.sessionId)).toEqual(["REAL"]);
    expect(files.every((f) => f.path.endsWith(".jsonl"))).toBe(true);
  });

  test("returns an empty list when there are no projects", () => {
    // makeClaudeDir creates an empty projects/ dir; nothing to discover.
    expect(discoverSessionFiles()).toEqual([]);
  });
});
