import type { Database } from "bun:sqlite";
import { rootOf, threadLastTs, threadMessages } from "../thread.ts";
import { buildDigestInput, DIGEST_PROMPT, pickDigestModel } from "./prompt.ts";
import { staleThreads } from "./stale.ts";
import { rejectSummaryReason, writeSummary } from "./store.ts";

// The summarize pipeline, behind the Summarizer seam (claudeSummarizer spawns the
// CLI, tests pass a fake). Design notes: docs/architecture.md ("Digest").

export interface SummarizeRequest {
  // The rendered, size-bounded transcript.
  input: string;
  model: string;
  // Passed in rather than imported by the adapter, so the seam carries everything
  // the adapter needs and a test can assert on it.
  prompt: string;
}

export interface SummarizeResult {
  ok: boolean;
  text: string;
  // Why it failed, for the log line. Empty on success.
  detail: string;
  // The model runner could not be started at all (missing binary); a drain aborts
  // on this instead of retrying it per thread.
  fatal?: boolean;
}

export type Summarizer = (request: SummarizeRequest) => SummarizeResult;

// A hung `claude -p` (a wedged API stream, a stuck MCP handshake) would otherwise
// hang every drain behind it forever. Generous on purpose: a large thread on the
// big model legitimately takes minutes, and a timeout that fires on a slow-but-
// alive call wastes a finished summary.
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
    // exitCode plus a signal, and "was killed by SIGTERM" hides the actual cause.
    // A timeout is an ordinary failure, not fatal: the next drain retries it.
    if (proc.exitedDueToTimeout) {
      return { ok: false, text, detail: `${bin} timed out after ${timeoutMs}ms and was killed` };
    }
    if (proc.exitCode !== 0) {
      const firstErrorLine = proc.stderr.toString().trim().split("\n")[0] ?? "";
      // A killed child (OOM, a teardown SIGTERM) has a null exitCode and a signal
      // instead, and "exited null" tells the operator nothing.
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
  // Only "summarized" writes anything; the other two leave the thread stale so a
  // later run retries it.
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
  // Called once the transcript is rendered and the model chosen, before the call
  // is made: without it a wedged model call leaves no trace of which thread, how
  // big, or which model.
  onStart?: (about: { root: string; bytes: number; model: string }) => void;
}

// Never throws for an expected failure: the caller (a hook, a drain) needs the
// outcome, not an exception.
export const runDigest = (
  db: Database,
  sessionId: string,
  opts: DigestOptions = {},
): DigestOutcome => {
  const summarize = opts.summarize ?? claudeSummarizer;
  const root = rootOf(db, sessionId);
  const input = buildDigestInput(threadMessages(db, sessionId));
  // Captured with the transcript, not after the model returns: the call takes
  // minutes, and anything indexed during it must stay stale rather than be stamped
  // as covered by a summary that never saw it.
  const coversLastTs = threadLastTs(db, root);
  // An empty render must never be summarized: the prompt would dutifully answer
  // "(No substantive session content.)" and storing that would permanently mark
  // the thread as summarized-and-fresh.
  if (input.length === 0) return { status: "skipped", root, reason: "nothing to summarize" };

  // Measured where the transcript is produced, so the tiering never needs a second
  // render.
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
  // Counted apart from failures: a skip is not something that went wrong.
  skipped: number;
  // Set when a fatal outcome stopped the run early (the model runner is missing).
  aborted?: string;
}

export interface DrainOptions {
  summarize?: Summarizer;
  onStart?: (count: number) => void;
  onThreadStart?: (about: { root: string; bytes: number; model: string }) => void;
  // Called as each thread finishes, so a caller can report progress during a run
  // that takes minutes.
  onOutcome?: (outcome: DigestOutcome) => void;
}

// Up to `limit` stale threads, newest first (a recent thread is the one most
// likely to be recalled). A fatal outcome aborts, since every remaining thread
// would fail the same way.
export const runDrain = (db: Database, limit: number, opts: DrainOptions = {}): DrainResult => {
  const result: DrainResult = { outcomes: [], summarized: 0, failed: 0, skipped: 0 };
  const threads = staleThreads(db, limit);
  if (threads.length > 0) opts.onStart?.(threads.length);
  for (const thread of threads) {
    // An unexpected throw from any step (a SQL error, an unreadable row) must not
    // abandon the remaining threads and the closing report.
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
    if (outcome.fatal) {
      result.aborted = outcome.reason;
      break;
    }
  }
  return result;
};
