import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { runIndex } from "../src/indexer.ts";
import type { Classified, SessionFile, SourceAdapter } from "../src/sources/adapter.ts";
import { parseLine } from "../src/sources/adapter.ts";
import { CLAUDE_CODE_PROVIDER, discoverSessionFiles } from "../src/sources/claude-code.ts";
import { adapterFor, discoverAllSessionFiles } from "../src/sources/registry.ts";
import {
  makeClaudeDir,
  type TempClaude,
  userMsg,
  writeSession,
  writeSubagent,
} from "./fixtures.ts";

// Force a file's mtime so ordering is deterministic (real runs differ by ms).
const setMtime = (path: string, secondsFromEpoch: number): void => {
  const when = new Date(secondsFromEpoch * 1000);
  fs.utimesSync(path, when, when);
};

const oneMsg = (sessionId: string) => [userMsg(sessionId, "u1", "work")];

// A minimal second source, exercising the whole adapter contract against a log
// format that shares nothing with Claude Code's: its own directory layout, its own
// event grammar ({who, id, say}), synthesized provider-prefixed message ids, and a
// per-turn model field. What the indexer tests through it is the seam itself.
const FAKE_PROVIDER = "fake-agent";

const classifyFakeLine = (raw: unknown): Classified => {
  if (typeof raw !== "object" || raw === null) return { kind: "skip" };
  const event = raw as Record<string, unknown>;
  if (event.who !== "human" && event.who !== "bot") return { kind: "skip" };
  if (typeof event.id !== "string" || typeof event.say !== "string") return { kind: "skip" };
  return {
    kind: "message",
    // Synthesized, provider-prefixed: stable across re-reads and collision-free
    // against other sources' ids (the dedup-key guarantee in the contract).
    uuid: `${FAKE_PROVIDER}:${event.id}`,
    parentUuid: null,
    sessionId: null,
    role: event.who === "human" ? "user" : "assistant",
    text: event.say,
    ts: typeof event.at === "string" ? event.at : null,
    cwd: typeof event.dir === "string" ? event.dir : null,
    gitBranch: null,
    isSidechain: false,
    model: typeof event.brain === "string" ? event.brain : null,
  };
};

const makeFakeAdapter = (root: string): SourceAdapter => ({
  id: FAKE_PROVIDER,
  discover: () => {
    let names: string[];
    try {
      names = fs.readdirSync(root).filter((name) => name.endsWith(".jsonl"));
    } catch {
      return [];
    }
    return names.map((name): SessionFile => {
      const path = join(root, name);
      const stat = fs.statSync(path);
      return {
        path,
        kind: "session",
        sessionId: name.slice(0, -".jsonl".length),
        projectDir: root,
        provider: FAKE_PROVIDER,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    });
  },
  *classifyLines(lines: string[]) {
    for (const line of lines) {
      if (!line) continue;
      const parsed = parseLine(line);
      if (parsed === undefined) continue;
      yield classifyFakeLine(parsed);
    }
  },
});

const writeFakeSession = (root: string, sessionId: string, lines: unknown[]): string => {
  fs.mkdirSync(root, { recursive: true });
  const path = join(root, `${sessionId}.jsonl`);
  fs.writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
};

describe("claude-code discoverSessionFiles", () => {
  let env: TempClaude;

  beforeEach(() => {
    env = makeClaudeDir();
    process.env.CEREBRO_CLAUDE_DIR = env.claudeRoot;
  });
  afterEach(() => env.cleanup());

  test("stamps every file with the claude-code provider", () => {
    writeSession(env.projects, "-repo", "S", oneMsg("S"));
    const files = discoverSessionFiles();
    expect(files).toHaveLength(1);
    expect(files[0]!.provider).toBe(CLAUDE_CODE_PROVIDER);
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

describe("registry", () => {
  let env: TempClaude;
  let fakeRoot: string;

  beforeEach(() => {
    env = makeClaudeDir();
    process.env.CEREBRO_CLAUDE_DIR = env.claudeRoot;
    fakeRoot = join(env.claudeRoot, "fake-sessions");
  });
  afterEach(() => env.cleanup());

  test("adapterFor resolves a registered provider and throws on an unknown one", () => {
    expect(adapterFor(CLAUDE_CODE_PROVIDER).id).toBe(CLAUDE_CODE_PROVIDER);
    expect(() => adapterFor("no-such-tool")).toThrow("no source adapter registered");
  });

  test("discoverAllSessionFiles returns files oldest-first by mtime (invariant #3)", () => {
    const a = writeSession(env.projects, "-repo", "AAA", oneMsg("AAA"));
    const b = writeSession(env.projects, "-repo", "BBB", oneMsg("BBB"));
    const c = writeSession(env.projects, "-repo", "CCC", oneMsg("CCC"));
    // Set mtimes out of filename order: B oldest, then C, then A.
    setMtime(a, 1_700_000_300);
    setMtime(b, 1_700_000_100);
    setMtime(c, 1_700_000_200);

    const files = discoverAllSessionFiles();
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

    const files = discoverAllSessionFiles();
    expect(files.map((f) => f.sessionId)).toEqual(["aaa", "mmm", "zzz"]);
  });

  test("merges files across adapters into one oldest-first order", () => {
    const claudeFile = writeSession(env.projects, "-repo", "CLAUDE-S", oneMsg("CLAUDE-S"));
    const fakeFile = writeFakeSession(fakeRoot, "FAKE-S", [
      { who: "human", id: "m1", say: "hello" },
    ]);
    setMtime(fakeFile, 1_700_000_100); // fake session is older
    setMtime(claudeFile, 1_700_000_200);

    const adapters = [adapterFor(CLAUDE_CODE_PROVIDER), makeFakeAdapter(fakeRoot)];
    const files = discoverAllSessionFiles(adapters);
    expect(files.map((f) => `${f.provider}:${f.sessionId}`)).toEqual([
      "fake-agent:FAKE-S",
      "claude-code:CLAUDE-S",
    ]);
  });
});

describe("indexing through a second source adapter", () => {
  let env: TempClaude;
  let fakeRoot: string;
  let db: Database;
  let adapters: SourceAdapter[];

  beforeEach(() => {
    env = makeClaudeDir();
    process.env.CEREBRO_CLAUDE_DIR = env.claudeRoot;
    fakeRoot = join(env.claudeRoot, "fake-sessions");
    db = openDb(":memory:");
    adapters = [adapterFor(CLAUDE_CODE_PROVIDER), makeFakeAdapter(fakeRoot)];
  });
  afterEach(() => {
    db.close();
    env.cleanup();
  });

  test("normalizes, attributes, and dedups a foreign log format end to end", () => {
    writeSession(env.projects, "-repo", "CLAUDE-S", oneMsg("CLAUDE-S"));
    writeFakeSession(fakeRoot, "FAKE-S", [
      { who: "human", id: "m1", say: "please refactor the parser", at: "2026-02-01T10:00:00Z" },
      { who: "bot", id: "m2", say: "refactored parser.ts", brain: "gpt-6-codex" },
      { unrelated: "bookkeeping noise" },
    ]);

    const result = runIndex(db, { adapters });
    expect(result.newMessages).toBe(3); // 1 claude + 2 fake; the noise line is skipped
    // Idempotent re-index across both sources (dedup on the synthesized uuid too).
    expect(runIndex(db, { adapters }).newMessages).toBe(0);

    const fake = db
      .query("SELECT provider, model, msg_count FROM sessions WHERE session_id = 'FAKE-S'")
      .get() as { provider: string; model: string | null; msg_count: number };
    expect(fake).toEqual({ provider: "fake-agent", model: "gpt-6-codex", msg_count: 2 });

    const claude = db
      .query("SELECT provider FROM sessions WHERE session_id = 'CLAUDE-S'")
      .get() as { provider: string };
    expect(claude.provider).toBe("claude-code");

    // The foreign session's text is in the same FTS index as everything else.
    const hit = db
      .query(
        `SELECT m.session_id FROM messages_fts f JOIN messages m ON m.id = f.rowid
         WHERE messages_fts MATCH 'refactored'`,
      )
      .get() as { session_id: string };
    expect(hit.session_id).toBe("FAKE-S");
  });

  test("the sessions listing surfaces the provider through the threads view", () => {
    writeFakeSession(fakeRoot, "FAKE-S", [
      { who: "human", id: "m1", say: "hi", at: "2026-02-01T10:00:00Z" },
    ]);
    runIndex(db, { adapters });
    const row = db.query("SELECT provider, model FROM threads WHERE id = 'FAKE-S'").get() as {
      provider: string | null;
      model: string | null;
    };
    expect(row.provider).toBe("fake-agent");
  });
});
