import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionEndPayload } from "../src/commands/digest.ts";
import { openDb } from "../src/db.ts";
import {
  claudeSummarizer,
  getSummary,
  runDigest,
  runDrain,
  type SummarizeRequest,
  type Summarizer,
  staleThreads,
} from "../src/digest/index.ts";
import { runIndex } from "../src/indexer.ts";
import {
  assistantMsg,
  makeClaudeDir,
  type TempClaude,
  ts,
  userMsg,
  writeSession,
} from "./fixtures.ts";

// A valid summary has to clear SUMMARY_MIN_CHARS and must not look like an error.
const GOOD_SUMMARY = "Worked on the limiter in cerebro. Keywords: limiter, cerebro";

// A Summarizer that records what it was asked and answers with a canned result.
const fakeSummarizer = (
  result: Partial<ReturnType<Summarizer>> = {},
): { summarize: Summarizer; calls: SummarizeRequest[] } => {
  const calls: SummarizeRequest[] = [];
  const summarize: Summarizer = (request) => {
    calls.push(request);
    return { ok: true, text: GOOD_SUMMARY, detail: "", ...result };
  };
  return { summarize, calls };
};

describe("runDigest", () => {
  let env: TempClaude;
  let db: Database;

  beforeEach(() => {
    env = makeClaudeDir();
    process.env.CEREBRO_CLAUDE_DIR = env.claudeRoot;
    writeSession(env.projects, "-repo", "SESS", [
      userMsg("SESS", "u1", "how do I tune the limiter", { timestamp: ts(0) }),
      assistantMsg("SESS", "a1", "raise the window", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    db = openDb(":memory:");
    runIndex(db);
  });
  afterEach(() => {
    db.close();
    env.cleanup();
  });

  test("stores the summary and reports the size and model it used", () => {
    const { summarize, calls } = fakeSummarizer();
    const outcome = runDigest(db, "SESS", summarize);

    expect(outcome.status).toBe("summarized");
    expect(outcome.root).toBe("SESS");
    expect(outcome.chars).toBe(GOOD_SUMMARY.length);
    expect(outcome.bytes).toBeGreaterThan(0);
    expect(getSummary(db, "SESS")?.summary).toBe(GOOD_SUMMARY);
    // The model that was picked is the model recorded with the summary.
    expect(getSummary(db, "SESS")?.model).toBe(outcome.model!);

    // The seam carries the rendered transcript and the prompt, so the adapter
    // needs nothing else.
    expect(calls.length).toBe(1);
    expect(calls[0]!.input).toContain("how do I tune the limiter");
    expect(calls[0]!.prompt).toContain("You are summarizing a single Claude Code session");
    expect(calls[0]!.model).toBe(outcome.model!);
  });

  test("a thread with no messages is skipped, never summarized as empty", () => {
    // A session row with no messages at all: rendering it produces nothing, and
    // storing "(No substantive session content.)" would mark it fresh forever.
    db.run(
      "INSERT INTO sessions (session_id, root_session_id, msg_count) VALUES ('EMPTY', 'EMPTY', 0)",
    );
    const { summarize, calls } = fakeSummarizer();
    const outcome = runDigest(db, "EMPTY", summarize);

    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("empty transcript");
    expect(calls).toEqual([]); // the model is never called
    expect(getSummary(db, "EMPTY")).toBeNull();
  });

  test("a non-zero exit from the model stores nothing", () => {
    const { summarize } = fakeSummarizer({ ok: false, text: "", detail: "claude exited 1" });
    const outcome = runDigest(db, "SESS", summarize);

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toBe("claude exited 1");
    expect(getSummary(db, "SESS")).toBeNull();
  });

  test("empty model output stores nothing", () => {
    const { summarize } = fakeSummarizer({
      ok: false,
      text: "",
      detail: "claude produced no output",
    });
    expect(runDigest(db, "SESS", summarize).status).toBe("failed");
    expect(getSummary(db, "SESS")).toBeNull();
  });

  test("output that looks like an error is rejected by the storage guard", () => {
    // The incident this guard exists for: an API failure stored as a summary.
    const { summarize } = fakeSummarizer({ text: "Prompt is too long: 213000 tokens" });
    const outcome = runDigest(db, "SESS", summarize);

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("rejected");
    expect(getSummary(db, "SESS")).toBeNull();
  });

  test("a fragment too short to be a summary is rejected", () => {
    const { summarize } = fakeSummarizer({ text: "ok" });
    expect(runDigest(db, "SESS", summarize).status).toBe("failed");
    expect(getSummary(db, "SESS")).toBeNull();
  });

  test("a missing model runner is fatal, so a drain can stop instead of retrying it", () => {
    const { summarize } = fakeSummarizer({
      ok: false,
      text: "",
      detail: "could not run claude: not found",
      fatal: true,
    });
    const outcome = runDigest(db, "SESS", summarize);

    expect(outcome.status).toBe("failed");
    expect(outcome.fatal).toBe(true);
  });

  test("every failure leaves the thread stale so a later run retries it", () => {
    const { summarize } = fakeSummarizer({ ok: false, text: "", detail: "claude exited 1" });
    runDigest(db, "SESS", summarize);
    expect(staleThreads(db, 10).map((t) => t.id)).toContain("SESS");
  });
});

describe("claudeSummarizer", () => {
  let dir: string;
  let saved: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "cerebro-claude-"));
    saved = process.env.CEREBRO_CLAUDE_BIN;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CEREBRO_CLAUDE_BIN;
    else process.env.CEREBRO_CLAUDE_BIN = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A stand-in for the claude CLI, so the adapter's wiring (transcript on stdin,
  // prompt as an argv, the model flag) is verified without calling a model.
  const fakeClaude = (script: string): string => {
    const path = join(dir, "claude");
    fs.writeFileSync(path, `#!/usr/bin/env bash\n${script}\n`);
    fs.chmodSync(path, 0o755);
    process.env.CEREBRO_CLAUDE_BIN = path;
    return path;
  };

  test("passes the transcript on stdin and the prompt as an argument", () => {
    // Echo back what arrived, so the assertion covers both channels at once.
    fakeClaude('printf "stdin:%s args:%s model:%s" "$(cat)" "$5" "$4"');
    const result = claudeSummarizer({ input: "TRANSCRIPT", model: "some-model", prompt: "PROMPT" });

    expect(result.ok).toBe(true);
    expect(result.text).toBe("stdin:TRANSCRIPT args:PROMPT model:some-model");
  });

  test("reports a non-zero exit as a failure and keeps the stderr reason", () => {
    fakeClaude('echo "Prompt is too long" >&2; exit 1');
    const result = claudeSummarizer({ input: "T", model: "m", prompt: "P" });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("exited 1");
    expect(result.detail).toContain("Prompt is too long");
  });

  test("reports empty output as a failure", () => {
    fakeClaude("exit 0");
    expect(claudeSummarizer({ input: "T", model: "m", prompt: "P" }).ok).toBe(false);
  });

  test("a binary that cannot be run at all is fatal", () => {
    process.env.CEREBRO_CLAUDE_BIN = join(dir, "does-not-exist");
    const result = claudeSummarizer({ input: "T", model: "m", prompt: "P" });

    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
  });
});

describe("runDrain", () => {
  let env: TempClaude;
  let db: Database;

  beforeEach(() => {
    env = makeClaudeDir();
    process.env.CEREBRO_CLAUDE_DIR = env.claudeRoot;
    for (const id of ["ONE", "TWO", "THREE"]) {
      writeSession(env.projects, "-repo", id, [
        userMsg(id, `${id}-u1`, `work on ${id}`, { timestamp: ts(0) }),
      ]);
    }
    db = openDb(":memory:");
    runIndex(db);
  });
  afterEach(() => {
    db.close();
    env.cleanup();
  });

  test("an empty backlog does no work", () => {
    const { summarize, calls } = fakeSummarizer();
    runDrain(db, 8, { summarize }); // first pass summarizes everything
    const second = runDrain(db, 8, { summarize });

    expect(second.outcomes).toEqual([]);
    expect(second.summarized).toBe(0);
    expect(calls.length).toBe(3); // only the first pass called the model
  });

  test("stops at the limit and leaves the rest for the next run", () => {
    const { summarize } = fakeSummarizer();
    const result = runDrain(db, 2, { summarize });

    expect(result.summarized).toBe(2);
    expect(result.outcomes.length).toBe(2);
    expect(staleThreads(db, 10).length).toBe(1);
  });

  test("keeps going after one thread fails, and counts it", () => {
    let call = 0;
    const summarize: Summarizer = () => {
      call++;
      return call === 1
        ? { ok: false, text: "", detail: "claude exited 1" }
        : { ok: true, text: GOOD_SUMMARY, detail: "" };
    };
    const result = runDrain(db, 8, { summarize });

    expect(result.summarized).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.outcomes.length).toBe(3);
    // The failed one is still stale, the other two are not.
    expect(staleThreads(db, 10).length).toBe(1);
  });

  test("aborts the run when the model runner cannot be started at all", () => {
    const { summarize, calls } = fakeSummarizer({
      ok: false,
      text: "",
      detail: "could not run claude: not found",
      fatal: true,
    });
    const result = runDrain(db, 8, { summarize });

    expect(result.aborted).toContain("could not run claude");
    expect(calls.length).toBe(1); // no point trying the other two
    expect(result.outcomes.length).toBe(1);
  });
});

describe("parseSessionEndPayload", () => {
  test("reads the session id a SessionEnd hook sends", () => {
    expect(parseSessionEndPayload('{"session_id":"abc123","reason":"clear"}')).toBe("abc123");
  });

  test("returns null for a payload without a usable id", () => {
    expect(parseSessionEndPayload('{"reason":"clear"}')).toBeNull();
    expect(parseSessionEndPayload('{"session_id":""}')).toBeNull();
    expect(parseSessionEndPayload('{"session_id":42}')).toBeNull();
  });

  test("returns null on malformed JSON instead of throwing", () => {
    expect(parseSessionEndPayload("{not json")).toBeNull();
    expect(parseSessionEndPayload("")).toBeNull();
  });
});
