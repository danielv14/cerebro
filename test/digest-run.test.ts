import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionEndPayload } from "../src/commands/digest.ts";
import { openDb } from "../src/db.ts";
import type { DigestConfig } from "../src/digest/config.ts";
import { DEFAULT_DIGEST_MODELS } from "../src/digest/prompt.ts";
import {
  createClaudeSummarizer,
  runDigest,
  runDrain,
  type SummarizeRequest,
  type Summarizer,
} from "../src/digest/run.ts";
import { DRAIN_SETTLE_MS, staleThreads } from "../src/digest/stale.ts";
import { getSummary, retryDelayMs } from "../src/digest/store.ts";
import { runIndex } from "../src/indexer.ts";
import { threadLastTs } from "../src/thread.ts";
import {
  assistantMsg,
  makeClaudeDir,
  type TempClaude,
  ts,
  userMsg,
  writeSession,
} from "./fixtures.ts";

// These assert on the pipeline, not on which model it picked, so they all pass the
// shipped tiering.
const models = DEFAULT_DIGEST_MODELS;

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
    writeSession(env.projects, "-repo", "SESS", [
      userMsg("SESS", "u1", "how do I tune the limiter", { timestamp: ts(0) }),
      assistantMsg("SESS", "a1", "raise the window", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    db = openDb(":memory:");
    runIndex(db, { adapters: env.adapters });
  });
  afterEach(() => {
    db.close();
    env.cleanup();
  });

  test("stores the summary and reports the size and model it used", () => {
    const { summarize, calls } = fakeSummarizer();
    const outcome = runDigest(db, "SESS", { summarize, models });

    expect(outcome.status).toBe("summarized");
    expect(outcome.root).toBe("SESS");
    expect(outcome.chars).toBe(GOOD_SUMMARY.length);
    expect(outcome.bytes).toBeGreaterThan(0);
    expect(getSummary(db, "SESS")?.summary).toBe(GOOD_SUMMARY);
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
    const outcome = runDigest(db, "EMPTY", { summarize, models });

    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("nothing to summarize");
    expect(calls).toEqual([]); // the model is never called
    expect(getSummary(db, "EMPTY")).toBeNull();
  });

  test("a non-zero exit from the model stores nothing", () => {
    const { summarize } = fakeSummarizer({ ok: false, text: "", detail: "claude exited 1" });
    const outcome = runDigest(db, "SESS", { summarize, models });

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
    expect(runDigest(db, "SESS", { summarize, models }).status).toBe("failed");
    expect(getSummary(db, "SESS")).toBeNull();
  });

  test("output that looks like an error is rejected by the storage guard", () => {
    // The incident this guard exists for: an API failure stored as a summary.
    const { summarize } = fakeSummarizer({ text: "Prompt is too long: 213000 tokens" });
    const outcome = runDigest(db, "SESS", { summarize, models });

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("rejected");
    expect(getSummary(db, "SESS")).toBeNull();
  });

  test("a fragment too short to be a summary is rejected", () => {
    const { summarize } = fakeSummarizer({ text: "ok" });
    expect(runDigest(db, "SESS", { summarize, models }).status).toBe("failed");
    expect(getSummary(db, "SESS")).toBeNull();
  });

  test("a missing model runner is fatal, so a drain can stop instead of retrying it", () => {
    const { summarize } = fakeSummarizer({
      ok: false,
      text: "",
      detail: "could not run claude: not found",
      fatal: true,
    });
    const outcome = runDigest(db, "SESS", { summarize, models });

    expect(outcome.status).toBe("failed");
    expect(outcome.fatal).toBe(true);
  });

  test("stamps the last_ts the transcript covered, not the one at store time", () => {
    // The model call takes minutes. Anything indexed while it runs must stay stale:
    // stamping the thread's *current* last_ts would mark messages the summary never
    // saw as covered, and the staleness predicate would never surface them again.
    const beforeCall = threadLastTs(db, "SESS");
    const summarize: Summarizer = () => {
      // Stand in for "a new message landed during the call".
      db.run(
        `INSERT INTO messages (uuid, session_id, parent_uuid, ts, role, text, is_sidechain)
         VALUES ('u2', 'SESS', 'a1', '2099-01-01T00:00:00.000Z', 'user', 'later work', 0)`,
      );
      db.run("UPDATE sessions SET last_ts = '2099-01-01T00:00:00.000Z' WHERE session_id = 'SESS'");
      return { ok: true, text: GOOD_SUMMARY, detail: "" };
    };

    expect(runDigest(db, "SESS", { summarize, models }).status).toBe("summarized");
    expect(getSummary(db, "SESS")?.source_last_ts).toBe(beforeCall);
    // ...so the thread is stale again immediately, and the new message gets covered.
    expect(staleThreads(db, 10).map((t) => t.id)).toContain("SESS");
  });

  test("reports the thread and the model before the call, for a hung one", () => {
    const started: { root: string; bytes: number; model: string }[] = [];
    const { summarize } = fakeSummarizer();
    runDigest(db, "SESS", { summarize, models, onStart: (about) => started.push(about) });

    expect(started.length).toBe(1);
    expect(started[0]!.root).toBe("SESS");
    expect(started[0]!.bytes).toBeGreaterThan(0);
    expect(started[0]!.model).toBeTruthy();
  });

  test("every failure leaves the thread stale so a later run retries it", () => {
    const { summarize } = fakeSummarizer({ ok: false, text: "", detail: "claude exited 1" });
    runDigest(db, "SESS", { summarize, models });
    expect(staleThreads(db, 10).map((t) => t.id)).toContain("SESS");
  });
});

describe("createClaudeSummarizer", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "cerebro-claude-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const config = (over: Partial<DigestConfig> = {}): DigestConfig => ({
    models: DEFAULT_DIGEST_MODELS,
    timeoutMs: 30_000,
    claudeBin: join(dir, "claude"),
    ...over,
  });

  // A stand-in for the claude CLI, so the adapter's wiring (transcript on stdin,
  // prompt as an argv, the model flag) is verified without calling a model.
  const fakeClaude = (script: string): string => {
    const path = join(dir, "claude");
    fs.writeFileSync(path, `#!/usr/bin/env bash\n${script}\n`);
    fs.chmodSync(path, 0o755);
    return path;
  };

  test("passes the transcript on stdin and the prompt as an argument", () => {
    // Echo back what arrived, so the assertion covers both channels at once.
    fakeClaude('printf "stdin:%s args:%s model:%s" "$(cat)" "$5" "$4"');
    const result = createClaudeSummarizer(config())({
      input: "TRANSCRIPT",
      model: "some-model",
      prompt: "PROMPT",
    });

    expect(result.ok).toBe(true);
    expect(result.text).toBe("stdin:TRANSCRIPT args:PROMPT model:some-model");
  });

  test("reports a non-zero exit as a failure and keeps the stderr reason", () => {
    fakeClaude('echo "Prompt is too long" >&2; exit 1');
    const result = createClaudeSummarizer(config())({ input: "T", model: "m", prompt: "P" });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("exited 1");
    expect(result.detail).toContain("Prompt is too long");
  });

  test("reports empty output as a failure", () => {
    fakeClaude("exit 0");
    expect(createClaudeSummarizer(config())({ input: "T", model: "m", prompt: "P" }).ok).toBe(
      false,
    );
  });

  test("a call that exceeds the timeout is killed and reported, not hung", () => {
    // The stand-in sleeps far past the timeout; without the kill this test (and a
    // real drain) would hang.
    fakeClaude("sleep 30");
    const result = createClaudeSummarizer(config({ timeoutMs: 250 }))({
      input: "T",
      model: "m",
      prompt: "P",
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("timed out after 250ms");
    // An ordinary failure, not fatal: the next drain retries the thread.
    expect(result.fatal).toBeUndefined();
  });

  test("a binary that cannot be run at all is fatal", () => {
    const summarize = createClaudeSummarizer(config({ claudeBin: join(dir, "does-not-exist") }));
    const result = summarize({ input: "T", model: "m", prompt: "P" });

    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
  });
});

describe("runDrain", () => {
  let env: TempClaude;
  let db: Database;

  beforeEach(() => {
    env = makeClaudeDir();
    for (const id of ["ONE", "TWO", "THREE"]) {
      writeSession(env.projects, "-repo", id, [
        userMsg(id, `${id}-u1`, `work on ${id}`, { timestamp: ts(0) }),
      ]);
    }
    db = openDb(":memory:");
    runIndex(db, { adapters: env.adapters });
  });
  afterEach(() => {
    db.close();
    env.cleanup();
  });

  test("an empty backlog does no work", () => {
    const { summarize, calls } = fakeSummarizer();
    runDrain(db, 8, { summarize, models }); // first pass summarizes everything
    const second = runDrain(db, 8, { summarize, models });

    expect(second.outcomes).toEqual([]);
    expect(second.summarized).toBe(0);
    expect(calls.length).toBe(3); // only the first pass called the model
  });

  test("stops at the limit and leaves the rest for the next run", () => {
    const { summarize } = fakeSummarizer();
    const result = runDrain(db, 2, { summarize, models });

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
    const result = runDrain(db, 8, { summarize, models });

    expect(result.summarized).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.outcomes.length).toBe(3);
    // The failed one is still stale, the other two are not.
    expect(staleThreads(db, 10).length).toBe(1);
  });

  test("a timed-out call fails that thread and the drain moves on", () => {
    // The timeout arrives through the Summarizer seam as an ordinary non-fatal
    // failure, so a drain treats it like any other failed thread: count it, leave
    // it stale, keep going.
    let call = 0;
    const summarize: Summarizer = () => {
      call++;
      return call === 1
        ? { ok: false, text: "", detail: "claude timed out after 250ms and was killed" }
        : { ok: true, text: GOOD_SUMMARY, detail: "" };
    };
    const result = runDrain(db, 8, { summarize, models });

    expect(result.failed).toBe(1);
    expect(result.summarized).toBe(2);
    expect(result.aborted).toBeUndefined();
    expect(result.outcomes[0]!.reason).toContain("timed out");
    expect(staleThreads(db, 10).length).toBe(1); // the timed-out thread is retried later
  });

  test("an unexpected throw takes down one thread, not the run", () => {
    // The bash loop got per-thread isolation for free. Here a SQL error or any
    // other surprise inside one thread must not abandon the rest of the batch or
    // the closing report.
    let call = 0;
    const summarize: Summarizer = () => {
      call++;
      if (call === 1) throw new Error("something unexpected");
      return { ok: true, text: GOOD_SUMMARY, detail: "" };
    };
    const result = runDrain(db, 8, { summarize, models });

    expect(result.outcomes.length).toBe(3);
    expect(result.summarized).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.outcomes[0]!.reason).toContain("something unexpected");
  });

  test("a skipped thread is counted apart from a failure", () => {
    // A skip is not a model failure, and digest.log is the only signal for "is the
    // model broken?".
    db.run(
      "INSERT INTO sessions (session_id, root_session_id, msg_count, last_ts) VALUES ('EMPTY', 'EMPTY', 0, '2026-01-01T00:00:00Z')",
    );
    const outcome = runDigest(db, "EMPTY", { summarize: fakeSummarizer().summarize, models });
    expect(outcome.status).toBe("skipped");

    const result = runDrain(db, 8, { summarize: fakeSummarizer().summarize, models });
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0); // the threads view keeps empty threads out entirely
  });

  test("aborts the run when the model runner cannot be started at all", () => {
    const { summarize, calls } = fakeSummarizer({
      ok: false,
      text: "",
      detail: "could not run claude: not found",
      fatal: true,
    });
    const result = runDrain(db, 8, { summarize, models });

    expect(result.aborted).toContain("could not run claude");
    expect(calls.length).toBe(1); // no point trying the other two
    expect(result.outcomes.length).toBe(1);
  });
});

describe("digest failure backoff (#205)", () => {
  let env: TempClaude;
  let db: Database;
  const NOW = Date.parse(ts(0)) + 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  const failing = fakeSummarizer({ ok: false, text: "", detail: "claude exited 1" });

  const failure = (root: string) =>
    db.query("SELECT * FROM digest_failures WHERE root_session_id = ?").get(root) as {
      attempts: number;
      last_error: string;
      retry_after: string;
    } | null;

  beforeEach(() => {
    env = makeClaudeDir();
    for (const id of ["ONE", "TWO"]) {
      writeSession(env.projects, "-repo", id, [
        userMsg(id, `${id}-u1`, `work on ${id}`, { timestamp: ts(0) }),
      ]);
    }
    db = openDb(":memory:");
    runIndex(db, { adapters: env.adapters });
  });
  afterEach(() => {
    db.close();
    env.cleanup();
  });

  test("the wait doubles per attempt and is capped at a week", () => {
    expect(retryDelayMs(1)).toBe(6 * HOUR);
    expect(retryDelayMs(2)).toBe(12 * HOUR);
    expect(retryDelayMs(3)).toBe(24 * HOUR);
    expect(retryDelayMs(20)).toBe(7 * 24 * HOUR);
  });

  test("a failed attempt is recorded with its reason and next retry", () => {
    runDigest(db, "ONE", { summarize: failing.summarize, models, clock: () => NOW });
    runDigest(db, "ONE", { summarize: failing.summarize, models, clock: () => NOW });
    expect(failure("ONE")).toMatchObject({
      attempts: 2,
      last_error: "claude exited 1",
      retry_after: new Date(NOW + 12 * HOUR).toISOString(),
    });
  });

  test("a rejected output counts as a failure too", () => {
    const rejecting = fakeSummarizer({ text: "Prompt is too long" });
    runDigest(db, "ONE", { summarize: rejecting.summarize, models, clock: () => NOW });
    expect(failure("ONE")?.attempts).toBe(1);
  });

  test("a fatal outcome is the runner's problem and backs no thread off", () => {
    const fatal = fakeSummarizer({ ok: false, text: "", detail: "not found", fatal: true });
    runDigest(db, "ONE", { summarize: fatal.summarize, models, clock: () => NOW });
    expect(failure("ONE")).toBeNull();
  });

  test("a stored summary clears the record", () => {
    runDigest(db, "ONE", { summarize: failing.summarize, models, clock: () => NOW });
    runDigest(db, "ONE", { summarize: fakeSummarizer().summarize, models, clock: () => NOW });
    expect(failure("ONE")).toBeNull();
  });

  test("a drain skips a thread in backoff until its retry time, then takes it", () => {
    runDigest(db, "ONE", { summarize: failing.summarize, models, clock: () => NOW });

    const { summarize, calls } = fakeSummarizer();
    const early = runDrain(db, 8, { summarize, models, clock: () => NOW + HOUR });
    expect(early.outcomes.map((o) => o.root)).toEqual(["TWO"]);

    const later = runDrain(db, 8, { summarize, models, clock: () => NOW + 6 * HOUR });
    expect(later.outcomes.map((o) => o.root)).toEqual(["ONE"]);
    expect(calls.length).toBe(2);
  });

  test("an explicit digest run ignores the backoff", () => {
    runDigest(db, "ONE", { summarize: failing.summarize, models, clock: () => NOW });
    const outcome = runDigest(db, "ONE", {
      summarize: fakeSummarizer().summarize,
      models,
      clock: () => NOW + HOUR,
    });
    expect(outcome.status).toBe("summarized");
  });

  test("a failure late in a drain is dated when it happened, not when the drain began", () => {
    let tick = NOW;
    const clock = () => {
      tick += HOUR;
      return tick;
    };
    runDrain(db, 8, { summarize: failing.summarize, models, clock });
    // The drain read the clock once to select, then once per recorded failure.
    expect(failure("ONE")?.retry_after).toBe(new Date(NOW + 2 * HOUR + 6 * HOUR).toISOString());
    expect(failure("TWO")?.retry_after).toBe(new Date(NOW + 3 * HOUR + 6 * HOUR).toISOString());
  });

  test("a thread whose digest throws is backed off too, so it cannot loop", () => {
    const throwing: Summarizer = () => {
      throw new Error("something unexpected");
    };
    runDrain(db, 8, { summarize: throwing, models, clock: () => NOW });
    expect(failure("ONE")).toMatchObject({ attempts: 1, last_error: "something unexpected" });
  });

  test("the backoff still lists the thread as stale, with its failures (#204)", () => {
    runDigest(db, "ONE", { summarize: failing.summarize, models, clock: () => NOW });
    const row = staleThreads(db).find((thread) => thread.id === "ONE");
    expect(row).toMatchObject({ failed_attempts: 1 });
  });
});

describe("digest drain settle window (#204)", () => {
  let env: TempClaude;
  let db: Database;
  // Exactly at ts(0) is "just now", so ACTIVE (last active at ts(0)) has not settled.
  const NOW = Date.parse(ts(0)) + 60_000;

  beforeEach(() => {
    env = makeClaudeDir();
    writeSession(env.projects, "-repo", "ACTIVE", [
      userMsg("ACTIVE", "a-u1", "still working", { timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo", "SETTLED", [
      userMsg("SETTLED", "s-u1", "done earlier", { timestamp: ts(-2 * 60 * 60) }),
    ]);
    db = openDb(":memory:");
    runIndex(db, { adapters: env.adapters });
  });
  afterEach(() => {
    db.close();
    env.cleanup();
  });

  test("a thread active within the settle window waits; the older backlog goes first", () => {
    const { summarize } = fakeSummarizer();
    const result = runDrain(db, 8, { summarize, models, clock: () => NOW });
    expect(result.outcomes.map((o) => o.root)).toEqual(["SETTLED"]);
    expect(staleThreads(db).map((t) => t.id)).toEqual(["ACTIVE"]);
  });

  test("a drain that can take nothing counts what it held back", () => {
    const { summarize } = fakeSummarizer();
    runDrain(db, 8, { summarize, models, clock: () => NOW });
    const again = runDrain(db, 8, { summarize, models, clock: () => NOW });
    expect(again.outcomes).toEqual([]);
    expect(again.heldBack).toBe(1);
  });

  test("once settled, the thread is drained", () => {
    const { summarize } = fakeSummarizer();
    const result = runDrain(db, 8, { summarize, models, clock: () => NOW + DRAIN_SETTLE_MS });
    expect(result.outcomes.map((o) => o.root).sort()).toEqual(["ACTIVE", "SETTLED"]);
    expect(result.heldBack).toBe(0);
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
