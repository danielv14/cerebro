import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { type CliIO, commands, GLOBAL_OPTIONS, runCli } from "../src/cli.ts";
import { isGroup } from "../src/commands/command.ts";
import { parseHookPayload } from "../src/commands/relevant.ts";
import { openDb } from "../src/db.ts";
import { writeSummary } from "../src/digest/index.ts";
import { runIndex } from "../src/indexer.ts";
import {
  assistantMsg,
  makeClaudeDir,
  type TempClaude,
  ts,
  userMsg,
  writeSession,
} from "./fixtures.ts";

// A capturing CliIO so a test can assert on output and exit code without spawning
// the binary or touching the global process.exitCode.
const makeIO = () => {
  const logs: string[] = [];
  const errs: string[] = [];
  let raw = "";
  let exitCode = 0;
  const io: CliIO = {
    log: (line) => logs.push(line),
    error: (line) => errs.push(line),
    write: (text) => {
      raw += text;
    },
    setExitCode: (code) => {
      exitCode = code;
    },
  };
  return {
    io,
    logs,
    errs,
    get raw() {
      return raw;
    },
    get exitCode() {
      return exitCode;
    },
  };
};

describe("parseHookPayload (relevant --stdin)", () => {
  test("reads the prompt and the cwd from a valid payload", () => {
    expect(parseHookPayload('{"prompt":"how did the migration go","cwd":"/repo"}')).toEqual({
      prompt: "how did the migration go",
      cwd: "/repo",
    });
  });

  test("degrades to an empty prompt when the field is missing", () => {
    expect(parseHookPayload('{"cwd":"/repo"}')).toEqual({ prompt: "", cwd: "/repo" });
  });

  test("degrades to an empty prompt when the field is not a string", () => {
    expect(parseHookPayload('{"prompt":42}')).toEqual({ prompt: "", cwd: null });
  });

  test("degrades to no cwd when it is missing, empty, or not a string (#88)", () => {
    // No cwd means `relevant` ranks globally, exactly as it did before the boost.
    expect(parseHookPayload('{"prompt":"p"}')).toEqual({ prompt: "p", cwd: null });
    expect(parseHookPayload('{"prompt":"p","cwd":""}')).toEqual({ prompt: "p", cwd: null });
    // A non-string cwd fails the whole schema, so the prompt degrades too.
    expect(parseHookPayload('{"prompt":"p","cwd":42}')).toEqual({ prompt: "", cwd: null });
  });

  test("degrades to an empty prompt and no cwd on malformed JSON", () => {
    expect(parseHookPayload("{not json")).toEqual({ prompt: "", cwd: null });
    expect(parseHookPayload("")).toEqual({ prompt: "", cwd: null });
  });
});

describe("option declarations", () => {
  // The accepted vocabulary of every command, pinned. The dispatcher derives what
  // it accepts from these declarations, so this is the one place that notices a
  // flag quietly disappearing from a command (or appearing on the wrong one).
  const EXPECTED: Record<string, string[]> = {
    index: ["dry-run", "full", "rebuild"],
    search: ["all", "branch", "json", "limit", "project", "prose", "role", "since"],
    sessions: ["branch", "json", "limit", "project", "since"],
    recent: ["context", "cwd", "days", "json", "limit"],
    relevant: ["context", "cwd", "json", "limit", "stdin"],
    show: ["full", "json", "range"],
    stats: ["json"],
    skills: ["json", "limit", "since"],
    doctor: ["full", "json"],
    maintain: [],
    backup: ["keep", "to"],
    version: ["json"],
    "digest stale": ["ids", "json", "limit"],
    "digest run": ["stdin"],
    "digest drain": ["limit"],
    "digest prompt": [],
    "digest input": [],
    "digest model": ["bytes"],
    "digest write": ["model"],
    "digest search": ["json", "limit"],
    "digest show": ["json"],
  };

  const declared = (): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const [name, node] of commands) {
      if (isGroup(node)) {
        for (const [action, sub] of Object.entries(node.subcommands)) {
          out[`${name} ${action}`] = Object.keys(sub.options).sort();
        }
      } else {
        out[name] = Object.keys(node.options).sort();
      }
    }
    return out;
  };

  test("every command declares exactly the options it accepts", () => {
    expect(declared()).toEqual(
      Object.fromEntries(Object.entries(EXPECTED).map(([k, v]) => [k, [...v].sort()])),
    );
  });

  test("a flag name shared by several commands agrees on its kind everywhere", () => {
    // The parser needs one table up front, so two commands declaring --full as a
    // boolean and a string would silently make one of them wrong. Seeded with the
    // globals because parserOptions adds those first and first declaration wins: a
    // command redeclaring --db as a flag would be parsed as a string forever, and
    // read back as absent on every invocation.
    const kinds = new Map<string, string>(
      Object.entries(GLOBAL_OPTIONS).map(([option, spec]) => [option, spec.kind]),
    );
    for (const [, node] of commands) {
      const tables = isGroup(node)
        ? Object.values(node.subcommands).map((sub) => sub.options)
        : [node.options];
      for (const table of tables) {
        for (const [option, spec] of Object.entries(table)) {
          const seen = kinds.get(option);
          if (seen !== undefined) expect(`${option}:${spec.kind}`).toBe(`${option}:${seen}`);
          else kinds.set(option, spec.kind);
        }
      }
    }
  });
});

describe("runCli", () => {
  let env: TempClaude;

  beforeEach(() => {
    env = makeClaudeDir();
    process.env.CEREBRO_CLAUDE_DIR = env.claudeRoot;
  });
  afterEach(() => env.cleanup());

  // A fresh in-memory db seeded from the current fixture files. runCli owns the
  // db lifetime (it closes it in finally), so each call gets its own.
  const seeded = () => (): ReturnType<typeof openDb> => {
    const db = openDb(":memory:");
    runIndex(db);
    return db;
  };

  const memDb = () => openDb(":memory:");

  // The fixture timestamps sit at a fixed base (see ts()), so pinning the dispatcher's
  // instant there is what lets these tests use the real default windows.
  const NOW = Date.parse(ts(0));

  test("--help prints help, no error, exit 0, and never opens a db", () => {
    const cap = makeIO();
    let opened = false;
    runCli(["--help"], cap.io, () => {
      opened = true;
      return memDb();
    });
    expect(cap.logs.join("\n")).toContain("permanent verbatim archive");
    expect(cap.errs).toEqual([]);
    expect(cap.exitCode).toBe(0);
    expect(opened).toBe(false); // help short-circuits before opening the db
  });

  test("no command prints help", () => {
    const cap = makeIO();
    runCli([], cap.io, () => memDb());
    expect(cap.logs.join("\n")).toContain("Usage:");
    expect(cap.exitCode).toBe(0);
  });

  test("unknown command reports it, prints help, exits 1", () => {
    const cap = makeIO();
    runCli(["bogus"], cap.io, () => memDb());
    expect(cap.errs.join("\n")).toContain("Unknown command: bogus");
    expect(cap.logs.join("\n")).toContain("Usage:");
    expect(cap.exitCode).toBe(1);
  });

  test("--limit must be a positive integer", () => {
    const cap = makeIO();
    runCli(["search", "foo", "--limit", "0"], cap.io, () => memDb());
    expect(cap.errs.join("\n")).toContain('--limit must be a positive integer (got "0")');
    expect(cap.exitCode).toBe(1);
  });

  test("an unknown option exits 1 with a clean message, not a stack trace", () => {
    const cap = makeIO();
    runCli(["search", "--nope"], cap.io, () => memDb());
    expect(cap.errs.join("\n").toLowerCase()).toContain("unknown option");
    expect(cap.exitCode).toBe(1);
  });

  test("a flag another command owns is rejected, not swallowed (#105)", () => {
    // --keep is backup's, --range is show's, --bytes is digest model's. Each used
    // to parse fine for any command and then be ignored in silence.
    for (const args of [
      ["sessions", "--keep", "3"],
      ["sessions", "--range", "1..2"],
      ["stats", "--bytes", "5"],
      ["maintain", "--json"],
    ]) {
      const cap = makeIO();
      runCli(args, cap.io, () => memDb());
      expect(cap.errs.join("\n")).toContain(`Unknown option --${args[1]!.slice(2)}`);
      expect(cap.errs.join("\n")).toContain(`cerebro ${args[0]}`);
      expect(cap.exitCode).toBe(1);
    }
  });

  test("a flag another digest action owns is rejected per action", () => {
    const cap = makeIO();
    runCli(["digest", "search", "--bytes", "5"], cap.io, () => memDb());
    expect(cap.errs.join("\n")).toContain("Unknown option --bytes for `cerebro digest search`");
    expect(cap.exitCode).toBe(1);
  });

  test("the global options work with every command", () => {
    // --db is how every test and hook points at a throwaway archive, and --help
    // short-circuits regardless of the command.
    const cap = makeIO();
    runCli(["sessions", "--db", ":memory:"], cap.io, () => memDb());
    expect(cap.errs).toEqual([]);
    expect(cap.exitCode).toBe(0);

    const help = makeIO();
    runCli(["backup", "--help"], help.io, () => memDb());
    expect(help.logs.join("\n")).toContain("Usage:");
    expect(help.exitCode).toBe(0);
  });

  test("show without an id fails via the shared resolveOrThrow", () => {
    const cap = makeIO();
    runCli(["show"], cap.io, () => memDb());
    expect(cap.errs.join("\n")).toContain("show: missing <session-id>");
    expect(cap.exitCode).toBe(1);
  });

  test("digest input without an id fails with its own label via the same helper", () => {
    const cap = makeIO();
    runCli(["digest", "input"], cap.io, () => memDb());
    expect(cap.errs.join("\n")).toContain("digest input: missing <session-id>");
    expect(cap.exitCode).toBe(1);
  });

  test("show on an unknown id reports no match and exits 1", () => {
    const cap = makeIO();
    runCli(["show", "NOPE"], cap.io, () => memDb());
    expect(cap.errs.join("\n")).toContain('No session matching "NOPE".');
    expect(cap.exitCode).toBe(1);
  });

  test("show renders a thread outline for an existing session", () => {
    writeSession(env.projects, "-repo", "SESS", [
      userMsg("SESS", "u1", "hello there", { timestamp: ts(0) }),
      assistantMsg("SESS", "a1", "general kenobi", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    const cap = makeIO();
    runCli(["show", "SESS"], cap.io, seeded());
    const out = cap.logs.join("\n");
    expect(out).toContain("Thread SESS");
    expect(out).toContain("hello there");
    expect(out).toContain("Full transcript: cerebro show <id> --full");
    expect(cap.exitCode).toBe(0);
  });

  test("show --range prints a numbered verbatim slice (#58)", () => {
    writeSession(env.projects, "-repo", "SESS", [
      userMsg("SESS", "u1", "first", { timestamp: ts(0) }),
      assistantMsg("SESS", "a1", "second", { parentUuid: "u1", timestamp: ts(1) }),
      userMsg("SESS", "u2", "third", { parentUuid: "a1", timestamp: ts(2) }),
    ]);
    const cap = makeIO();
    runCli(["show", "SESS", "--range", "2..3"], cap.io, seeded());
    const out = cap.logs.join("\n");
    expect(out).toContain("showing 2..3 of 3 message(s)");
    expect(out).toContain("#2 assistant");
    expect(out).toContain("second");
    expect(out).not.toContain("first");
    expect(cap.exitCode).toBe(0);
  });

  test("show --range rejects malformed and out-of-bounds ranges", () => {
    writeSession(env.projects, "-repo", "SESS", [userMsg("SESS", "u1", "only one")]);
    const bad = makeIO();
    runCli(["show", "SESS", "--range", "3..2"], bad.io, seeded());
    expect(bad.errs.join("\n")).toContain("--range must be N or A..B");
    expect(bad.exitCode).toBe(1);

    const oob = makeIO();
    runCli(["show", "SESS", "--range", "5"], oob.io, seeded());
    expect(oob.errs.join("\n")).toContain("starts at 5 but the thread has 1 message(s)");
    expect(oob.exitCode).toBe(1);
  });

  test("search with no hits prints the empty-state line", () => {
    writeSession(env.projects, "-repo", "SESS", [
      userMsg("SESS", "u1", "work", { timestamp: ts(0) }),
    ]);
    const cap = makeIO();
    runCli(["search", "zzzneverappears"], cap.io, seeded());
    expect(cap.logs.join("\n")).toContain("No matches.");
    expect(cap.exitCode).toBe(0);
  });

  test("stats prints the archive counts", () => {
    writeSession(env.projects, "-repo", "SESS", [
      userMsg("SESS", "u1", "work", { timestamp: ts(0) }),
      assistantMsg("SESS", "a1", "ok", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    const cap = makeIO();
    runCli(["stats"], cap.io, seeded());
    const out = cap.logs.join("\n");
    expect(out).toContain("Threads:");
    expect(out).toContain("Messages:");
    expect(cap.exitCode).toBe(0);
  });

  test("skills counts both markers and --json carries the window", () => {
    writeSession(env.projects, "-repo", "SESS", [
      userMsg("SESS", "u1", "<command-name>/commit</command-name>", { timestamp: ts(0) }),
      assistantMsg(
        "SESS",
        "a1",
        [{ type: "tool_use", name: "Skill", input: { skill: "commit" } }],
        {
          parentUuid: "u1",
          timestamp: ts(1),
        },
      ),
    ]);
    const cap = makeIO();
    runCli(["skills"], cap.io, seeded());
    const out = cap.logs.join("\n");
    expect(out).toContain("1 skills");
    expect(out).toContain("name");
    expect(out).toMatch(/commit\s+1\s+1\s+0\s+2/);
    expect(cap.exitCode).toBe(0);

    const jsonCap = makeIO();
    runCli(["skills", "--json"], jsonCap.io, seeded());
    const usage = JSON.parse(jsonCap.logs.join("\n"));
    expect(usage.rows).toHaveLength(1);
    expect(usage.distinct).toBe(1);
    expect(usage.from).toBe(ts(0));
    expect(usage.to).toBe(ts(1));
  });

  test("--json emits parseable rows for search, sessions, and stats (#54)", () => {
    writeSession(env.projects, "-repo", "SESS", [
      userMsg("SESS", "u1", "a limiter question", { timestamp: ts(0) }),
    ]);

    const searchCap = makeIO();
    runCli(["search", "limiter", "--json"], searchCap.io, seeded());
    const hits = JSON.parse(searchCap.logs.join("\n"));
    expect(hits.length).toBe(1);
    expect(hits[0].session_id).toBe("SESS");
    expect(hits[0].ordinal).toBe(1);

    const sessionsCap = makeIO();
    runCli(["sessions", "--json"], sessionsCap.io, seeded());
    expect(JSON.parse(sessionsCap.logs.join("\n"))[0].id).toBe("SESS");

    const statsCap = makeIO();
    runCli(["stats", "--json"], statsCap.io, seeded());
    const s = JSON.parse(statsCap.logs.join("\n"));
    expect(s.messages).toBe(1);
    expect(s.staleThreads).toBe(1);
  });

  test("--json emits an empty array on no matches instead of prose (#54)", () => {
    writeSession(env.projects, "-repo", "SESS", [userMsg("SESS", "u1", "hello")]);
    const cap = makeIO();
    runCli(["search", "zzyzx", "--json"], cap.io, seeded());
    expect(JSON.parse(cap.logs.join("\n"))).toEqual([]);
    expect(cap.exitCode).toBe(0);
  });

  test("--json emits an empty array rather than the empty-state prose, for every reader", () => {
    // This is the contract the deleted `present` helper used to pin: in JSON mode a
    // reader emits [] and never its human empty state. It lives in runCli's emit now.
    for (const args of [
      ["sessions", "--json"],
      ["search", "zzyzx", "--json"],
      ["digest", "search", "zzyzx", "--json"],
      ["recent", "--cwd", "/nowhere", "--json"],
      ["relevant", "zzzqqq", "--json"],
    ]) {
      const cap = makeIO();
      runCli(args, cap.io, () => memDb());
      expect(JSON.parse(cap.logs.join("\n"))).toEqual([]);
      expect(cap.errs).toEqual([]);
      expect(cap.exitCode).toBe(0);
    }
  });

  test("the human empty state is printed instead, once, when JSON is not asked for", () => {
    const cap = makeIO();
    runCli(["sessions"], cap.io, () => memDb());
    expect(cap.logs).toEqual(["No sessions indexed yet. Run: cerebro index"]);

    const digest = makeIO();
    runCli(["digest", "search", "zzyzx"], digest.io, () => memDb());
    expect(digest.logs).toEqual(["No matching summaries."]);
  });

  test("show --json returns the thread's messages (#54)", () => {
    writeSession(env.projects, "-repo", "SESS", [
      userMsg("SESS", "u1", "hello there", { timestamp: ts(0) }),
      assistantMsg("SESS", "a1", "general kenobi", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    const cap = makeIO();
    runCli(["show", "SESS", "--json"], cap.io, seeded());
    const payload = JSON.parse(cap.logs.join("\n"));
    expect(payload.id).toBe("SESS");
    expect(payload.total).toBe(2);
    expect(payload.messages[1].text).toBe("general kenobi");
  });

  test("show --range combined with --json returns the slice, not the whole thread", () => {
    writeSession(env.projects, "-repo", "SESS", [
      userMsg("SESS", "u1", "first", { timestamp: ts(0) }),
      assistantMsg("SESS", "a1", "second", { parentUuid: "u1", timestamp: ts(1) }),
      userMsg("SESS", "u2", "third", { parentUuid: "a1", timestamp: ts(2) }),
    ]);
    const cap = makeIO();
    runCli(["show", "SESS", "--range", "2..3", "--json"], cap.io, seeded());
    const payload = JSON.parse(cap.logs.join("\n"));
    expect(payload.total).toBe(3);
    expect(payload.from).toBe(2);
    expect(payload.messages.map((m: { text: string }) => m.text)).toEqual(["second", "third"]);
    // Range validation still applies in JSON mode.
    const bad = makeIO();
    runCli(["show", "SESS", "--range", "9", "--json"], bad.io, seeded());
    expect(bad.errs.join("\n")).toContain("starts at 9");
    expect(bad.exitCode).toBe(1);
  });

  test("search --since rejects invalid calendar dates and trailing garbage", () => {
    writeSession(env.projects, "-repo", "SESS", [userMsg("SESS", "u1", "limiter")]);
    for (const since of ["2026-31-01", "2026-01-31foo", "2026-02-30"]) {
      const cap = makeIO();
      runCli(["search", "limiter", "--since", since], cap.io, seeded());
      expect(cap.errs.join("\n")).toContain("--since must be a valid ISO date");
      expect(cap.exitCode).toBe(1);
    }
  });

  test("version prints the unstamped identity and never opens a db", () => {
    const cap = makeIO();
    let opened = false;
    runCli(["version"], cap.io, () => {
      opened = true;
      return memDb();
    });
    // A source run must not claim a commit it does not have.
    expect(cap.logs.join("\n")).toContain("cerebro dev (unknown, built unknown, bun ");
    expect(cap.exitCode).toBe(0);
    expect(opened).toBe(false);
  });

  test("version --json emits the stamp fields", () => {
    const cap = makeIO();
    runCli(["version", "--json"], cap.io, () => memDb());
    expect(JSON.parse(cap.logs.join("\n"))).toMatchObject({
      version: "dev",
      commit: "unknown",
      stamped: false,
    });
  });

  test("doctor reports on a healthy archive and exits 0", () => {
    writeSession(env.projects, "-repo", "SESS", [userMsg("SESS", "u1", "limiter")]);
    const cap = makeIO();
    runCli(["doctor"], cap.io, seeded());
    const out = cap.logs.join("\n");
    expect(out).toContain("Database");
    expect(out).toContain("schema");
    expect(out).toContain("All checks passed");
    expect(cap.exitCode).toBe(0);
  });

  test("doctor --json emits the checks and exits 1 on a hard failure", () => {
    writeSession(env.projects, "-repo", "SESS", [userMsg("SESS", "u1", "limiter")]);
    const cap = makeIO();
    runCli(["doctor", "--json"], cap.io, () => {
      const db = seeded()();
      db.run("PRAGMA user_version = 999"); // a schema this build cannot speak
      return db;
    });
    const payload = JSON.parse(cap.logs.join("\n"));
    expect(payload.ok).toBe(false);
    expect(payload.checks.find((c: { key: string }) => c.key === "schema").status).toBe("fail");
    expect(cap.exitCode).toBe(1);
  });

  test("sessions --since rejects an invalid date with the same message as search", () => {
    writeSession(env.projects, "-repo", "SESS", [userMsg("SESS", "u1", "limiter")]);
    const cap = makeIO();
    runCli(["sessions", "--since", "2026-02-30"], cap.io, seeded());
    expect(cap.errs.join("\n")).toContain(
      '--since must be a valid ISO date like 2026-01-31 (got "2026-02-30")',
    );
    expect(cap.exitCode).toBe(1);
  });

  test("search --role rejects a value outside user | assistant", () => {
    writeSession(env.projects, "-repo", "SESS", [userMsg("SESS", "u1", "limiter")]);
    const cap = makeIO();
    runCli(["search", "limiter", "--role", "system"], cap.io, seeded());
    expect(cap.errs.join("\n")).toContain('--role must be one of user | assistant (got "system")');
    expect(cap.exitCode).toBe(1);
  });

  test("a failing database open reports cleanly instead of throwing", () => {
    const cap = makeIO();
    runCli(["stats"], cap.io, () => {
      throw new Error("disk io error");
    });
    expect(cap.errs.join("\n")).toContain("could not open database");
    expect(cap.errs.join("\n")).toContain("disk io error");
    expect(cap.exitCode).toBe(1);
  });

  test("backup dispatch writes a snapshot and validates --keep", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const join = require("node:path").join;
    const dir = fs.mkdtempSync(join(os.tmpdir(), "cerebro-cli-backup-"));
    try {
      const dbPath = join(dir, "archive.sqlite");
      const ok = makeIO();
      runCli(["backup", "--db", dbPath], ok.io);
      expect(ok.logs.join("\n")).toContain("Backup written:");
      expect(fs.readdirSync(join(dir, "backups")).length).toBe(1);
      expect(ok.exitCode).toBe(0);

      const bad = makeIO();
      runCli(["backup", "--db", dbPath, "--keep", "0"], bad.io);
      expect(bad.errs.join("\n")).toContain("--keep must be a positive integer");
      expect(bad.exitCode).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("maintain runs the housekeeping and reports it (#56)", () => {
    writeSession(env.projects, "-repo", "SESS", [userMsg("SESS", "u1", "work")]);
    const cap = makeIO();
    runCli(["maintain"], cap.io, seeded());
    expect(cap.logs.join("\n")).toContain("Maintenance done");
    expect(cap.exitCode).toBe(0);
  });

  test("digest input writes the raw transcript to io.write (not log)", () => {
    writeSession(env.projects, "-repo", "SESS", [
      userMsg("SESS", "u1", "the body text", { timestamp: ts(0) }),
    ]);
    const cap = makeIO();
    runCli(["digest", "input", "SESS"], cap.io, seeded());
    expect(cap.raw).toContain("the body text");
    expect(cap.logs).toEqual([]); // raw stdout, never a logged line
    expect(cap.exitCode).toBe(0);
  });

  test("digest model prints the tier-picked model for a small thread", () => {
    // Neutralize the digest env overrides so the assertion holds regardless of the
    // dev/CI environment, then restore them.
    const keys = [
      "CEREBRO_DIGEST_MODEL",
      "CEREBRO_DIGEST_MODEL_LARGE",
      "CEREBRO_DIGEST_HAIKU_MAX_CHARS",
    ];
    const saved = keys.map((k) => process.env[k]);
    for (const k of keys) delete process.env[k];
    try {
      writeSession(env.projects, "-repo", "SESS", [
        userMsg("SESS", "u1", "short thread", { timestamp: ts(0) }),
      ]);
      const cap = makeIO();
      runCli(["digest", "model", "SESS"], cap.io, seeded());
      expect(cap.logs.join("\n")).toBe("claude-haiku-4-5");
      expect(cap.exitCode).toBe(0);
    } finally {
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i]!;
      });
    }
  });

  test("digest model without an id fails via the shared helper", () => {
    const cap = makeIO();
    runCli(["digest", "model"], cap.io, () => memDb());
    expect(cap.errs.join("\n")).toContain("digest model: missing <session-id>");
    expect(cap.exitCode).toBe(1);
  });

  test("digest model --bytes tiers on the given size without a session id (#47)", () => {
    const keys = [
      "CEREBRO_DIGEST_MODEL",
      "CEREBRO_DIGEST_MODEL_LARGE",
      "CEREBRO_DIGEST_HAIKU_MAX_CHARS",
    ];
    const saved = keys.map((k) => process.env[k]);
    for (const k of keys) delete process.env[k];
    try {
      const small = makeIO();
      runCli(["digest", "model", "--bytes", "100"], small.io, () => memDb());
      expect(small.logs.join("\n")).toBe("claude-haiku-4-5");
      expect(small.exitCode).toBe(0);

      const large = makeIO();
      runCli(["digest", "model", "--bytes", "5000000"], large.io, () => memDb());
      expect(large.logs.join("\n")).toBe("claude-sonnet-4-6[1m]");
      expect(large.exitCode).toBe(0);
    } finally {
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i]!;
      });
    }
  });

  test("digest model --bytes rejects a non-numeric size", () => {
    const cap = makeIO();
    runCli(["digest", "model", "--bytes", "lots"], cap.io, () => memDb());
    expect(cap.errs.join("\n")).toContain("--bytes must be a non-negative integer");
    expect(cap.exitCode).toBe(1);
  });

  test("digest show prints a stored summary", () => {
    writeSession(env.projects, "-repo", "SESS", [
      userMsg("SESS", "u1", "work", { timestamp: ts(0) }),
    ]);
    const cap = makeIO();
    runCli(["digest", "show", "SESS"], cap.io, () => {
      const db = openDb(":memory:");
      runIndex(db);
      writeSummary(db, "SESS", "A stored summary. Keywords: work");
      return db;
    });
    expect(cap.logs.join("\n")).toContain("A stored summary");
    expect(cap.exitCode).toBe(0);
  });

  test("digest stale --ids prints one full session id per line, no human formatting", () => {
    writeSession(env.projects, "-repo", "SESS", [
      userMsg("SESS", "u1", "unsummarized work", { timestamp: ts(0) }),
    ]);
    const cap = makeIO();
    runCli(["digest", "stale", "--ids"], cap.io, seeded());
    // Exactly the full id, nothing else: no msg counts, titles, or help footer that
    // the batch hook would otherwise have to scrape past.
    expect(cap.logs).toEqual(["SESS"]);
    expect(cap.exitCode).toBe(0);
  });

  test("digest stale --ids stays silent when nothing is stale", () => {
    writeSession(env.projects, "-repo", "SESS", [
      userMsg("SESS", "u1", "work", { timestamp: ts(0) }),
    ]);
    const cap = makeIO();
    runCli(["digest", "stale", "--ids"], cap.io, () => {
      const db = openDb(":memory:");
      runIndex(db);
      writeSummary(db, "SESS", "A stored summary. Keywords: work");
      return db;
    });
    // No "All threads are summarized" line in machine mode, so the hook's
    // `[ -n "$ids" ]` guard reads empty output as a clean backlog.
    expect(cap.logs).toEqual([]);
    expect(cap.exitCode).toBe(0);
  });

  test("recent --context emits the agent-facing block with guardrail and recall clauses", () => {
    writeSession(env.projects, "-repo", "SESS", [
      userMsg("SESS", "u1", "some work", { timestamp: ts(0) }),
    ]);
    const cap = makeIO();
    // /repo is not a real git repo, so recent falls back to project_path matching. The
    // pinned instant is what makes the default 14-day window cover the fixture's
    // fixed-base timestamps; no oversized --days needed.
    runCli(["recent", "--cwd", "/repo", "--context"], cap.io, seeded(), { now: NOW });
    const out = cap.logs.join("\n");
    expect(out).toContain("Recent Claude Code sessions in this repo");
    expect(out).toContain("Background only; ignore if unrelated to the current task.");
    expect(out).toContain("cerebro show <id>");
    expect(out).toContain('cerebro search "<terms>"');
    expect(cap.exitCode).toBe(0);
  });

  test("recent --context is silent when there are no matching sessions", () => {
    const cap = makeIO();
    runCli(["recent", "--cwd", "/repo", "--context"], cap.io, () => memDb(), { now: NOW });
    expect(cap.logs).toEqual([]);
    expect(cap.errs).toEqual([]);
    expect(cap.exitCode).toBe(0);
  });

  test("recent's window is measured from the dispatcher's instant (#125)", () => {
    // Two threads in the same project, three weeks apart. With the instant pinned to
    // the fresh one, the default 14-day window has to include it and exclude the other.
    writeSession(env.projects, "-repo", "FRESHTHREAD", [
      userMsg("FRESHTHREAD", "u1", "fresh work", { timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo", "OLDTHREAD", [
      userMsg("OLDTHREAD", "u2", "older work", { timestamp: ts(-21 * 86_400) }),
    ]);
    const cap = makeIO();
    runCli(["recent", "--cwd", "/repo", "--json"], cap.io, seeded(), { now: NOW });
    expect(JSON.parse(cap.logs.join("\n")).map((row: { id: string }) => row.id)).toEqual([
      "FRESHTHREAD",
    ]);

    // Widening the window brings the older thread back, from the same instant.
    const wide = makeIO();
    runCli(["recent", "--cwd", "/repo", "--days", "30", "--json"], wide.io, seeded(), { now: NOW });
    expect(JSON.parse(wide.logs.join("\n")).map((row: { id: string }) => row.id)).toEqual([
      "FRESHTHREAD",
      "OLDTHREAD",
    ]);
  });

  test("recent falls back to the invoked directory, and --cwd still wins (#125)", () => {
    writeSession(env.projects, "-repo", "SESS", [
      userMsg("SESS", "u1", "some work", { timestamp: ts(0) }),
    ]);
    const ambient = makeIO();
    runCli(["recent", "--json"], ambient.io, seeded(), { now: NOW, cwd: "/repo" });
    expect(JSON.parse(ambient.logs.join("\n")).map((row: { id: string }) => row.id)).toEqual([
      "SESS",
    ]);

    // The flag beats the ambient value, in both directions.
    const flagWins = makeIO();
    runCli(["recent", "--cwd", "/repo", "--json"], flagWins.io, seeded(), {
      now: NOW,
      cwd: "/elsewhere",
    });
    expect(JSON.parse(flagWins.logs.join("\n")).length).toBe(1);

    const flagMisses = makeIO();
    runCli(["recent", "--cwd", "/elsewhere", "--json"], flagMisses.io, seeded(), {
      now: NOW,
      cwd: "/repo",
    });
    expect(JSON.parse(flagMisses.logs.join("\n"))).toEqual([]);
  });

  test("relevant ranks globally on the ambient cwd, and boosts only on --cwd (#125)", () => {
    // relevant deliberately does not adopt the invoked directory: a manual call must
    // rank the same wherever it is typed. Two identical matches, one a month newer in
    // another repo, so only the boost can change the order.
    const month = 30 * 86_400;
    writeSession(env.projects, "-repo-mine", "MINETHREAD", [
      userMsg("MINETHREAD", "u1", "the limiter work", { cwd: "/repo-mine", timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo-other", "OTHERTHREAD", [
      userMsg("OTHERTHREAD", "u2", "the limiter work", {
        cwd: "/repo-other",
        timestamp: ts(month),
      }),
    ]);
    const ids = (cap: ReturnType<typeof makeIO>): string[] =>
      JSON.parse(cap.logs.join("\n")).map((row: { id: string }) => row.id);
    const now = Date.parse(ts(month));

    const ambient = makeIO();
    runCli(["relevant", "limiter", "--json"], ambient.io, seeded(), { now, cwd: "/repo-mine" });
    expect(ids(ambient)).toEqual(["OTHERTHREAD", "MINETHREAD"]);

    const scoped = makeIO();
    runCli(["relevant", "limiter", "--cwd", "/repo-mine", "--json"], scoped.io, seeded(), { now });
    expect(ids(scoped)).toEqual(["MINETHREAD", "OTHERTHREAD"]);
  });

  test("recent --days must be a positive number", () => {
    const cap = makeIO();
    runCli(["recent", "--cwd", "/repo", "--days", "0"], cap.io, () => memDb());
    expect(cap.errs.join("\n")).toContain("--days must be a positive number");
    expect(cap.exitCode).toBe(1);
  });

  test("relevant --context emits the agent-facing block with guardrail and recall clauses", () => {
    writeSession(env.projects, "-repo", "SESS", [
      userMsg("SESS", "u1", "indexing sqlite performance tuning", { timestamp: ts(0) }),
    ]);
    const cap = makeIO();
    runCli(["relevant", "sqlite performance", "--context"], cap.io, seeded());
    const out = cap.logs.join("\n");
    expect(out).toContain("Possibly relevant past Claude Code sessions");
    expect(out).toContain("ignore any that do not actually relate.");
    expect(out).toContain("To recall one: cerebro show <id>");
    expect(cap.exitCode).toBe(0);
  });

  test("relevant --context is silent when nothing matches", () => {
    writeSession(env.projects, "-repo", "SESS", [
      userMsg("SESS", "u1", "totally unrelated content", { timestamp: ts(0) }),
    ]);
    const cap = makeIO();
    runCli(["relevant", "zzzqqq nevermatches", "--context"], cap.io, seeded());
    expect(cap.logs).toEqual([]);
    expect(cap.exitCode).toBe(0);
  });

  test("relevant --cwd boosts threads from that repo (#88)", () => {
    // Equal text match; OTHER is a month fresher, so it leads without --cwd.
    writeSession(env.projects, "-repo-mine", "MINE", [
      userMsg("MINE", "u1", "notes about the limiter design", {
        cwd: "/repo-mine",
        timestamp: ts(0),
      }),
    ]);
    writeSession(env.projects, "-repo-other", "OTHER", [
      userMsg("OTHER", "u2", "notes about the limiter design", {
        cwd: "/repo-other",
        timestamp: ts(30 * 86_400),
      }),
    ]);

    const order = (args: string[]): string[] => {
      const cap = makeIO();
      runCli(["relevant", "limiter", "--json", ...args], cap.io, seeded());
      return (JSON.parse(cap.logs.join("\n")) as { id: string }[]).map((row) => row.id);
    };

    expect(order([])).toEqual(["OTHER", "MINE"]);
    expect(order(["--cwd", "/repo-mine"])).toEqual(["MINE", "OTHER"]);
  });

  // `digest run` / `digest drain` drive the real summarizer, so these go through a
  // stand-in for the claude CLI (CEREBRO_CLAUDE_BIN) rather than a seam injected in
  // the test. That covers the wiring the unit tests cannot: dispatch, argument
  // resolution, the reported line and the exit code.
  describe("digest run and drain", () => {
    let binDir: string;
    let savedBin: string | undefined;

    const fakeClaude = (script: string): void => {
      const path = join(binDir, "claude");
      fs.writeFileSync(path, `#!/usr/bin/env bash\n${script}\n`);
      fs.chmodSync(path, 0o755);
      process.env.CEREBRO_CLAUDE_BIN = path;
    };

    beforeEach(() => {
      binDir = fs.mkdtempSync(join(os.tmpdir(), "cerebro-cli-claude-"));
      savedBin = process.env.CEREBRO_CLAUDE_BIN;
      // Point at nothing by default, so a test that forgets fakeClaude() fails
      // loudly instead of spawning the developer's real claude CLI.
      process.env.CEREBRO_CLAUDE_BIN = join(binDir, "no-such-binary");
    });
    afterEach(() => {
      if (savedBin === undefined) delete process.env.CEREBRO_CLAUDE_BIN;
      else process.env.CEREBRO_CLAUDE_BIN = savedBin;
      fs.rmSync(binDir, { recursive: true, force: true });
    });

    test("digest run summarizes the thread and exits 0", () => {
      writeSession(env.projects, "-repo", "SESS", [
        userMsg("SESS", "u1", "tuning the limiter", { timestamp: ts(0) }),
      ]);
      fakeClaude('echo "Tuned the limiter in cerebro. Keywords: limiter"');
      const cap = makeIO();
      runCli(["digest", "run", "SESS"], cap.io, seeded());

      expect(cap.logs.join("\n")).toContain("Summarized SESS");
      expect(cap.exitCode).toBe(0);
    });

    test("digest run exits 1 and says why when no summary was stored", () => {
      writeSession(env.projects, "-repo", "SESS", [
        userMsg("SESS", "u1", "tuning the limiter", { timestamp: ts(0) }),
      ]);
      fakeClaude('echo "Prompt is too long" >&2; exit 1');
      const cap = makeIO();
      runCli(["digest", "run", "SESS"], cap.io, seeded());

      expect(cap.logs.join("\n")).toContain("Failed SESS");
      expect(cap.logs.join("\n")).toContain("digest drain will retry it");
      expect(cap.exitCode).toBe(1);
    });

    test("digest run on an unknown id reports it like every other id-taking command", () => {
      const cap = makeIO();
      runCli(["digest", "run", "NOPE"], cap.io, () => memDb());

      expect(cap.errs.join("\n")).toContain('No session matching "NOPE".');
      expect(cap.exitCode).toBe(1);
    });

    test("digest drain summarizes the backlog and reports the counts", () => {
      writeSession(env.projects, "-repo", "ONE", [
        userMsg("ONE", "u1", "first thread", { timestamp: ts(0) }),
      ]);
      writeSession(env.projects, "-repo", "TWO", [
        userMsg("TWO", "u2", "second thread", { timestamp: ts(1) }),
      ]);
      fakeClaude('echo "Did some work in cerebro. Keywords: work"');
      const cap = makeIO();
      runCli(["digest", "drain", "--limit", "2"], cap.io, seeded());

      // The per-thread lines are streamed as each one finishes, before the run
      // returns, so the reconciler's log shows progress instead of going quiet for
      // minutes. Order matters: header, then one line per thread, then the summary.
      expect(cap.logs[0]).toBe("Draining up to 2 stale thread(s): 2 to do.");
      // Per thread: the breadcrumb naming size and model, then the outcome. The
      // breadcrumb is what a wedged model call leaves behind.
      expect(cap.logs[1]).toMatch(/^Summarizing \w+: \d+ bytes -> \S+$/);
      expect(cap.logs[2]).toMatch(/^Summarized \w+: \d+ chars stored\.$/);
      expect(cap.logs.at(-1)).toBe("Drain complete: 2 summarized, 0 failed.");
      expect(cap.exitCode).toBe(0);
    });

    test("digest drain says the backlog is clean when nothing is stale", () => {
      writeSession(env.projects, "-repo", "SESS", [
        userMsg("SESS", "u1", "work", { timestamp: ts(0) }),
      ]);
      const cap = makeIO();
      runCli(["digest", "drain"], cap.io, () => {
        const db = openDb(":memory:");
        runIndex(db);
        writeSummary(db, "SESS", "A stored summary. Keywords: work");
        return db;
      });

      expect(cap.logs.join("\n")).toContain("Nothing stale, the backlog is clean.");
      expect(cap.exitCode).toBe(0);
    });

    test("digest drain aborts and exits 1 when the model runner cannot be started", () => {
      writeSession(env.projects, "-repo", "SESS", [
        userMsg("SESS", "u1", "work", { timestamp: ts(0) }),
      ]);
      process.env.CEREBRO_CLAUDE_BIN = join(binDir, "does-not-exist");
      const cap = makeIO();
      runCli(["digest", "drain"], cap.io, seeded());

      expect(cap.logs.join("\n")).toContain("Drain aborted:");
      expect(cap.exitCode).toBe(1);
    });
  });
});
