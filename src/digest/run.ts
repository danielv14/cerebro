import type { Database } from "bun:sqlite";
import { rootOf, threadMessages } from "../thread.ts";
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

// The real adapter. The transcript goes on the child's stdin and the prompt as an
// argv, which is exactly how the hooks invoked it. --no-session-persistence keeps
// Claude Code from writing this one-shot into ~/.claude/projects, where the indexer
// would pick it up as a bogus session whose first turn is the digest prompt.
export const claudeSummarizer: Summarizer = ({ input, model, prompt }) => {
  const bin = process.env.CEREBRO_CLAUDE_BIN || "claude";
  try {
    const proc = Bun.spawnSync([bin, "-p", "--no-session-persistence", "--model", model, prompt], {
      stdin: Buffer.from(input, "utf8"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = proc.stdout.toString().trim();
    if (proc.exitCode !== 0) {
      const firstErrorLine = proc.stderr.toString().trim().split("\n")[0] ?? "";
      return {
        ok: false,
        text,
        detail: `${bin} exited ${proc.exitCode}${firstErrorLine ? `: ${firstErrorLine}` : ""}`,
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

// Summarize one thread. Never throws for an expected failure: the caller (a hook,
// a drain) needs the outcome, not an exception.
export const runDigest = (
  db: Database,
  sessionId: string,
  summarize: Summarizer = claudeSummarizer,
): DigestOutcome => {
  const root = rootOf(db, sessionId);
  const input = buildDigestInput(threadMessages(db, sessionId));
  // An empty render must never be summarized: the prompt would dutifully answer
  // "(No substantive session content.)" and storing that would permanently mark a
  // thread as summarized-and-fresh.
  if (input.length === 0) return { status: "skipped", root, reason: "empty transcript" };

  // Measured where the transcript is produced, so the tiering never needs a second
  // render (which is what `digest model --bytes` existed to avoid in the hooks).
  const bytes = Buffer.byteLength(input, "utf8");
  const model = pickDigestModel(bytes);

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

  writeSummary(db, sessionId, result.text, model);
  return { status: "summarized", root, model, bytes, chars: result.text.length };
};

export interface DrainResult {
  outcomes: DigestOutcome[];
  summarized: number;
  failed: number;
  // Set when a fatal outcome stopped the run early (the model runner is missing).
  aborted?: string;
}

// Drain the digest backlog: up to `limit` stale threads, newest first, because a
// recent thread is the one most likely to be recalled. One thread failing must not
// abort the run, so failures are counted and the loop continues; a fatal outcome
// (no model runner at all) does abort, since every remaining thread would fail the
// same way.
export const runDrain = (
  db: Database,
  limit: number,
  summarize: Summarizer = claudeSummarizer,
): DrainResult => {
  const result: DrainResult = { outcomes: [], summarized: 0, failed: 0 };
  for (const thread of staleThreads(db, limit)) {
    const outcome = runDigest(db, thread.id, summarize);
    result.outcomes.push(outcome);
    if (outcome.status === "summarized") result.summarized++;
    else result.failed++;
    if (outcome.fatal) {
      result.aborted = outcome.reason;
      break;
    }
  }
  return result;
};
