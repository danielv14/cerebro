import type { Database } from "bun:sqlite";
import { rootOf, threadLastTs, threadMessages } from "../thread.ts";
import { buildDigestInput, DIGEST_PROMPT, pickDigestModel } from "./prompt.ts";
import { staleThreads } from "./stale.ts";
import { rejectSummaryReason, writeSummary } from "./store.ts";

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

// Generous on purpose: a large thread legitimately takes minutes, and a timeout
// on a slow-but-alive call wastes a finished summary.
const DIGEST_TIMEOUT_MS_DEFAULT = 10 * 60 * 1000;
export const digestTimeoutMs = (): number => {
  const parsed = Number(process.env.CEREBRO_DIGEST_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DIGEST_TIMEOUT_MS_DEFAULT;
};

// --no-session-persistence keeps Claude Code from writing this one-shot into
// ~/.claude/projects, where the indexer would pick it up as a bogus session.
export const claudeSummarizer: Summarizer = ({ input, model, prompt }) => {
  const bin = process.env.CEREBRO_CLAUDE_BIN || "claude";
  const timeoutMs = digestTimeoutMs();
  try {
    const proc = Bun.spawnSync([bin, "-p", "--no-session-persistence", "--model", model, prompt], {
      stdin: Buffer.from(input, "utf8"),
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    });
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
  summarize?: Summarizer;
  // Called before the model call, so a wedged call still leaves a trace of which
  // thread, how big, and which model.
  onStart?: (about: { root: string; bytes: number; model: string }) => void;
}

export const runDigest = (
  db: Database,
  sessionId: string,
  opts: DigestOptions = {},
): DigestOutcome => {
  const summarize = opts.summarize ?? claudeSummarizer;
  const root = rootOf(db, sessionId);
  const input = buildDigestInput(threadMessages(db, sessionId));
  // Captured with the transcript, not after the model returns: anything indexed
  // during the minutes-long call must stay stale.
  const coversLastTs = threadLastTs(db, root);
  // Never summarize an empty render: the prompt would answer with the no-content
  // form and storing it would permanently mark the thread summarized-and-fresh.
  if (input.length === 0) return { status: "skipped", root, reason: "nothing to summarize" };

  const bytes = Buffer.byteLength(input, "utf8");
  const model = pickDigestModel(bytes);
  opts.onStart?.({ root, bytes, model });

  const result = summarize({ input, model, prompt: DIGEST_PROMPT });
  if (!result.ok) {
    return { status: "failed", root, reason: result.detail, model, bytes, fatal: result.fatal };
  }
  const rejected = rejectSummaryReason(result.text);
  if (rejected) {
    return { status: "failed", root, reason: `rejected, ${rejected}`, model, bytes };
  }

  writeSummary(db, sessionId, result.text, model, coversLastTs);
  return { status: "summarized", root, model, bytes, chars: result.text.length };
};

export interface DrainResult {
  outcomes: DigestOutcome[];
  summarized: number;
  failed: number;
  skipped: number;
  aborted?: string;
}

export interface DrainOptions {
  summarize?: Summarizer;
  onStart?: (count: number) => void;
  onThreadStart?: (about: { root: string; bytes: number; model: string }) => void;
  onOutcome?: (outcome: DigestOutcome) => void;
}

export const runDrain = (db: Database, limit: number, opts: DrainOptions = {}): DrainResult => {
  const result: DrainResult = { outcomes: [], summarized: 0, failed: 0, skipped: 0 };
  const threads = staleThreads(db, limit);
  if (threads.length > 0) opts.onStart?.(threads.length);
  for (const thread of threads) {
    // One thread must never take the run down with it.
    let outcome: DigestOutcome;
    try {
      outcome = runDigest(db, thread.id, {
        summarize: opts.summarize,
        onStart: opts.onThreadStart,
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
