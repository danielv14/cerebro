import type { Database } from "bun:sqlite";
import { rootOf, threadLastTs, threadMessages } from "../thread.ts";
import { buildDigestInput, DIGEST_PROMPT, pickDigestModel } from "./prompt.ts";
import { staleThreads } from "./stale.ts";
import { rejectSummaryReason, writeSummary } from "./store.ts";

// The summarize pipeline: render a thread, tier the model on its size, call the
// model, refuse output that cannot be a summary, store it. This sequence used to
// live twice in bash (the clear hook and the reconciler), which made its rules
// untestable and let them drift; it lives here once instead.
//
// The model call sits behind the Summarizer seam. Two adapters satisfy it: the
// real one spawns the `claude` CLI, tests pass a fake. cerebro still owns no model
// policy on anyone's behalf beyond its own tiering, and it still never decides to
// summarize on its own: something has to invoke `digest run` or `digest drain`.

export interface SummarizeRequest {
  // The rendered, size-bounded transcript.
  input: string;
  // The model the tiering picked for this transcript's size.
  model: string;
  // The summarization prompt, passed in rather than imported by the adapter so the
  // seam carries everything the adapter needs and a test can assert on it.
  prompt: string;
}

export interface SummarizeResult {
  ok: boolean;
  text: string;
  // Why it failed, for the log line. Empty on success.
  detail: string;
  // The model runner could not be started at all (missing binary), as opposed to
  // one call failing. A drain aborts on this instead of retrying it per thread.
  fatal?: boolean;
}

export type Summarizer = (request: SummarizeRequest) => SummarizeResult;

// How long one model call may run before the child is killed. A hung `claude -p`
// (a wedged API stream, a stuck MCP handshake) would otherwise hang `digest run`
// and every drain behind it forever. Generous on purpose: a large thread on the
// big model legitimately takes minutes, and a timeout that fires on a slow-but-
// alive call wastes a finished summary. Overridable for tests and for operators
// with slower links.
const DIGEST_TIMEOUT_MS_DEFAULT = 10 * 60 * 1000;
export const digestTimeoutMs = (): number => {
  const parsed = Number(process.env.CEREBRO_DIGEST_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DIGEST_TIMEOUT_MS_DEFAULT;
};

// The real adapter. The transcript goes on the child's stdin and the prompt as an
// argv, which is exactly how the hooks invoked it. --no-session-persistence keeps
// Claude Code from writing this one-shot into ~/.claude/projects, where the indexer
// would pick it up as a bogus session whose first turn is the digest prompt.
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
    // A timeout is an ordinary failure, not fatal: the thread stays stale and the
    // next drain retries it.
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
  // "summarized" = stored. "skipped" = there was nothing to summarize. "failed" =
  // the model or the storage guard refused it. Only "summarized" writes anything;
  // the other two leave the thread stale so a later run retries it.
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
  // is made. The breadcrumb the bash pipeline used to log: without it a wedged
  // model call leaves no trace of which thread, how big, or which model.
  onStart?: (about: { root: string; bytes: number; model: string }) => void;
}

// Summarize one thread. Never throws for an expected failure: the caller (a hook,
// a drain) needs the outcome, not an exception.
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
  // "(No substantive session content.)" and storing that would permanently mark a
  // thread as summarized-and-fresh. Nothing retries this one, and nothing needs
  // to: the `threads` view excludes zero-message threads from the stale list.
  if (input.length === 0) return { status: "skipped", root, reason: "nothing to summarize" };

  // Measured where the transcript is produced, so the tiering never needs a second
  // render (which is what `digest model --bytes` existed to avoid in the hooks).
  const bytes = Buffer.byteLength(input, "utf8");
  const model = pickDigestModel(bytes);
  opts.onStart?.({ root, bytes, model });

  const result = summarize({ input, model, prompt: DIGEST_PROMPT });
  if (!result.ok) {
    return { status: "failed", root, reason: result.detail, model, bytes, fatal: result.fatal };
  }
  // The storage guard is the last line of defense: a past incident stored a
  // "Prompt is too long" error as a summary through a pipeline that skipped it.
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
  // Threads with nothing to summarize. Counted apart from failures: a skip is not
  // something that went wrong, and reporting it as a failure misleads the operator.
  skipped: number;
  // Set when a fatal outcome stopped the run early (the model runner is missing).
  aborted?: string;
}

export interface DrainOptions {
  summarize?: Summarizer;
  // Called once before the first thread, with how many will be attempted.
  onStart?: (count: number) => void;
  // Called for each thread once its model is chosen, before the call is made.
  onThreadStart?: (about: { root: string; bytes: number; model: string }) => void;
  // Called as each thread finishes, so a caller can report progress during a run
  // that takes minutes rather than only after it.
  onOutcome?: (outcome: DigestOutcome) => void;
}

// Drain the digest backlog: up to `limit` stale threads, newest first, because a
// recent thread is the one most likely to be recalled. One thread failing must not
// abort the run, so failures are counted and the loop continues; a fatal outcome
// (no model runner at all) does abort, since every remaining thread would fail the
// same way.
export const runDrain = (db: Database, limit: number, opts: DrainOptions = {}): DrainResult => {
  const result: DrainResult = { outcomes: [], summarized: 0, failed: 0, skipped: 0 };
  const threads = staleThreads(db, limit);
  if (threads.length > 0) opts.onStart?.(threads.length);
  for (const thread of threads) {
    // One thread must never take the run down with it. The bash loop got this for
    // free (each iteration was its own command); here an unexpected throw from any
    // step -- a SQL error, an unreadable row -- would otherwise abandon the
    // remaining threads and the closing report.
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
