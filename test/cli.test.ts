import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type CliIO, parseHookPayload, runCli } from "../src/cli.ts";
import { openDb } from "../src/db.ts";
import { writeSummary } from "../src/digest.ts";
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
  test("reads the prompt from a valid payload", () => {
    expect(parseHookPayload('{"prompt":"how did the migration go","cwd":"/repo"}')).toEqual({
      prompt: "how did the migration go",
    });
  });

  test("degrades to an empty prompt when the field is missing", () => {
    expect(parseHookPayload('{"cwd":"/repo"}')).toEqual({ prompt: "" });
  });

  test("degrades to an empty prompt when the field is not a string", () => {
    expect(parseHookPayload('{"prompt":42}')).toEqual({ prompt: "" });
  });

  test("degrades to an empty prompt on malformed JSON", () => {
    expect(parseHookPayload("{not json")).toEqual({ prompt: "" });
    expect(parseHookPayload("")).toEqual({ prompt: "" });
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

  test("show without an id fails via the shared resolveOrFail", () => {
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
    // /repo is not a real git repo, so recent falls back to project_path matching;
    // a huge --days window includes the fixture's fixed-base timestamp.
    runCli(["recent", "--cwd", "/repo", "--days", "100000", "--context"], cap.io, seeded());
    const out = cap.logs.join("\n");
    expect(out).toContain("Recent Claude Code sessions in this repo");
    expect(out).toContain("Background only; ignore if unrelated to the current task.");
    expect(out).toContain("cerebro show <id>");
    expect(out).toContain('cerebro search "<terms>"');
    expect(cap.exitCode).toBe(0);
  });

  test("recent --context is silent when there are no matching sessions", () => {
    const cap = makeIO();
    runCli(["recent", "--cwd", "/repo", "--days", "100000", "--context"], cap.io, () => memDb());
    expect(cap.logs).toEqual([]);
    expect(cap.errs).toEqual([]);
    expect(cap.exitCode).toBe(0);
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
});
