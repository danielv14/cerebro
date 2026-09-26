import type { Database } from "bun:sqlite";
import { rootOf, threadLastTs, threadMessages } from "../thread.ts";
import type { DigestConfig } from "./config.ts";
import {
  buildDigestInput,
  DIGEST_PROMPT,
  type DigestModelConfig,
  pickDigestModel,
} from "./prompt.ts";
import { countHeldBackThreads, drainableThreads } from "./stale.ts";
import {
  clearDigestFailure,
  recordDigestFailure,
  rejectSummaryReason,
  writeSummary,
} from "./store.ts";

// Design notes: docs/architecture.md ("Digest").

export interface SummarizeRequest {
  input: string;
  model: string;
  prompt: string;
}

export interface SummarizeResult {
  ok: boolean;
  text: string;
  detail: string;
  // The runner could not be started at all; a drain aborts instead of retrying
  // per thread.
  fatal?: boolean;
}

export type Summarizer = (request: SummarizeRequest) => SummarizeResult;

// --no-session-persistence keeps Claude Code from writing this one-shot into
// ~/.claude/projects, where the indexer would pick it up as a bogus session.
export const createClaudeSummarizer =
  ({ claudeBin: bin, timeoutMs }: DigestConfig): Summarizer =>
  ({ input, model, prompt }) => {
    try {
      const proc = Bun.spawnSync(
        [bin, "-p", "--no-session-persistence", "--model", model, prompt],
        {
          stdin: Buffer.from(input, "utf8"),
          stdout: "pipe",
          stderr: "pipe",
          timeout: timeoutMs,
        },
      );
      const text = proc.stdout.toString().trim();
      // Checked before the exit-code branch: a timed-out child also reports a null
      // exitCode plus a signal, which would hide the actual cause.
      if (proc.exitedDueToTimeout) {
        return { ok: false, text, detail: `${bin} timed out after ${timeoutMs}ms and was killed` };
      }
      if (proc.exitCode !== 0) {
        const firstErrorLine = proc.stderr.toString().trim().split("\n")[0] ?? "";
        const how =
          proc.exitCode === null ? `was killed by ${proc.signalCode}` : `exited ${proc.exitCode}`;
        return {
          ok: false,
          text,
          detail: `${bin} ${how}${firstErrorLine ? `: ${firstErrorLine}` : ""}`,
        };
      }
      if (!text) return { ok: false, text, detail: `${bin} produced no output` };
      return { ok: true, text, detail: "" };
    } catch (error) {
      // Bun throws when the executable cannot be found or run at all.
      return {
        ok: false,
        text: "",
        detail: `could not run ${bin}: ${(error as Error).message}`,
        fatal: true,
      };
    }
  };

export interface DigestOutcome {
  // Only "summarized" writes; the other two leave the thread stale for a retry.
  status: "summarized" | "skipped" | "failed";
  root: string;
  reason?: string;
  model?: string;
  bytes?: number;
  chars?: number;
  fatal?: boolean;
}

export interface DigestOptions {
  summarize: Summarizer;
  models: DigestModelConfig;
  // Called before the model call, so a wedged call still leaves a trace of which
  // thread, how big, and which model.
  onStart?: (about: { root: string; bytes: number; model: string }) => void;
  // When a failure is recorded, for the drain's backoff.
  now?: number;
}

export const runDigest = (db: Database, sessionId: string, opts: DigestOptions): DigestOutcome => {
  const root = rootOf(db, sessionId);
  const input = buildDigestInput(threadMessages(db, sessionId));
  // Captured with the transcript, not after the model returns: anything indexed
  // during the minutes-long call must stay stale.
  const coversLastTs = threadLastTs(db, root);
  // Never summarize an empty render: the prompt would answer with the no-content
  // form and storing it would permanently mark the thread summarized-and-fresh.
  if (input.length === 0) return { status: "skipped", root, reason: "nothing to summarize" };

  const bytes = Buffer.byteLength(input, "utf8");
  const model = pickDigestModel(bytes, opts.models);
  opts.onStart?.({ root, bytes, model });

  const result = opts.summarize({ input, model, prompt: DIGEST_PROMPT });
  // A fatal outcome is the runner's, not the thread's, so it never backs one off.
  if (!result.ok && result.fatal) {
    return { status: "failed", root, reason: result.detail, model, bytes, fatal: true };
  }
  const rejected = result.ok ? rejectSummaryReason(result.text) : null;
  if (!result.ok || rejected) {
    const reason = result.ok ? `rejected, ${rejected}` : result.detail;
    recordDigestFailure(db, root, reason, opts.now ?? Date.now());
    return { status: "failed", root, reason, model, bytes };
  }

  writeSummary(db, sessionId, result.text, model, coversLastTs);
  clearDigestFailure(db, root);
  return { status: "summarized", root, model, bytes, chars: result.text.length };
};

export interface DrainResult {
  outcomes: DigestOutcome[];
  summarized: number;
  failed: number;
  skipped: number;
  aborted?: string;
  // Stale threads the drain left for later: still active, or backing off.
  heldBack: number;
}

export interface DrainOptions {
  summarize: Summarizer;
  models: DigestModelConfig;
  onStart?: (count: number) => void;
  onThreadStart?: (about: { root: string; bytes: number; model: string }) => void;
  onOutcome?: (outcome: DigestOutcome) => void;
  now?: number;
}

export const runDrain = (db: Database, limit: number, opts: DrainOptions): DrainResult => {
  const now = opts.now ?? Date.now();
  const result: DrainResult = {
    outcomes: [],
    summarized: 0,
    failed: 0,
    skipped: 0,
    heldBack: countHeldBackThreads(db, now),
  };
  const threads = drainableThreads(db, limit, now);
  if (threads.length > 0) opts.onStart?.(threads.length);
  for (const thread of threads) {
    // One thread must never take the run down with it.
    let outcome: DigestOutcome;
    try {
      outcome = runDigest(db, thread.id, {
        summarize: opts.summarize,
        models: opts.models,
        onStart: opts.onThreadStart,
        now,
      });
    } catch (error) {
      outcome = { status: "failed", root: thread.id, reason: (error as Error).message };
    }
    opts.onOutcome?.(outcome);
    result.outcomes.push(outcome);
    if (outcome.status === "summarized") result.summarized++;
    else if (outcome.status === "skipped") result.skipped++;
    else result.failed++;
    // Fatal means every remaining thread would fail the same way.
    if (outcome.fatal) {
      result.aborted = outcome.reason;
      break;
    }
  }
  return result;
};
