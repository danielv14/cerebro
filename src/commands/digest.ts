import * as v from "valibot";
import {
  buildDigestInput,
  DIGEST_PROMPT,
  DIGEST_PROMPT_VERSION,
  type DigestOutcome,
  type DrainResult,
  getSummary,
  pickDigestModel,
  rejectSummaryReason,
  runDigest,
  runDrain,
  type StaleThread,
  type StoredSummary,
  type SummaryHit,
  searchSummaries,
  staleThreads,
  writeSummary,
} from "../digest/index.ts";
import { oneLine, projectName, shortId, shortTime } from "../render.ts";
import { threadMessages } from "../thread.ts";
import { type CommandContext, numberOption, present, readStdin, resolveOrFail } from "./context.ts";

// `digest stale` (human): one row per stale thread with the staleness reason, the
// title on its own line, then the how-to-summarize footer. `promptVersion` is passed
// in so this stays free of the staleness query's versioning.
export const staleListing = (rows: StaleThread[], opts: { promptVersion: number }): string[] => {
  const lines: string[] = [];
  for (const row of rows) {
    const reason =
      row.summary_version == null
        ? "never summarized"
        : row.summary_version < opts.promptVersion
          ? `prompt v${row.summary_version} < v${opts.promptVersion}`
          : "new activity since summary";
    lines.push(
      `${shortId(row.id)}  ${shortTime(row.last_ts)}  ${String(row.msgs).padStart(4)} msgs  ${projectName(row.project_path)}  [${reason}]`,
    );
    lines.push(`    ${oneLine(row.title ?? "(untitled)", 100)}`);
  }
  lines.push(
    `\n${rows.length} thread(s) need a summary. Summarize one:\n` +
      `  cerebro digest run <id>          (or drain the backlog: cerebro digest drain --limit N)`,
  );
  return lines;
};

// `digest stale --ids`: machine mode for the batch hook. One full session id per
// line, nothing else (no header, titles, or footer), so a caller never scrapes the
// human listing format; full ids, not shortId, so it skips the prefix round-trip.
export const staleIds = (rows: StaleThread[]): string[] => rows.map((row) => row.id);

// `digest search`: one header + one snippet line per summary hit, then the count
// footer pointing at both the thread and its stored summary.
export const summarySearchListing = (hits: SummaryHit[]): string[] => {
  const lines: string[] = [];
  for (const hit of hits) {
    lines.push(
      `${shortId(hit.id)}  ${shortTime(hit.last_ts)}  ${projectName(hit.project_path)}  ${oneLine(hit.title ?? "(untitled)", 70)}`,
    );
    lines.push(`    ${oneLine(hit.snippet, 160)}`);
  }
  lines.push(
    `\n${hits.length} summary hit(s). Open one: cerebro show <id>  |  full summary: cerebro digest show <id>`,
  );
  return lines;
};

// `digest show`: the summary header (root id, time, model, prompt version) then the
// stored summary body.
export const digestShow = (summary: StoredSummary): string[] => {
  const model = summary.model ? `, ${summary.model}` : "";
  return [
    `Summary for thread ${shortId(summary.root_session_id)}  ` +
      `(${shortTime(summary.summarized_at)}${model}, prompt v${summary.prompt_version})\n`,
    summary.summary,
  ];
};

// `digest show` empty state: no summary stored yet for this thread.
export const noSummaryHint = (sessionId: string): string =>
  `No summary yet for ${shortId(sessionId)}. Generate the backlog with: cerebro digest stale`;

// `digest write` confirmation: which thread the summary was saved to and its size.
export const summarySaved = (root: string, chars: number): string =>
  `Saved summary for thread ${shortId(root)} (${chars} chars).`;

// One line per summarize attempt, for `digest run` and for each thread of a
// `digest drain`. Both the hooks' logs and a human read these, so a failure always
// names the reason and says the thread is not lost.
export const digestOutcomeLine = (outcome: DigestOutcome): string => {
  const id = shortId(outcome.root);
  const size = outcome.bytes === undefined ? "" : ` ${outcome.bytes} bytes ->`;
  switch (outcome.status) {
    case "summarized":
      return `Summarized ${id}:${size} ${outcome.model}, ${outcome.chars} chars.`;
    case "skipped":
      return `Skipped ${id}: ${outcome.reason}; digest stale will retry it.`;
    default:
      return `Failed ${id}:${size} ${outcome.reason}; left unsummarized, digest stale will retry it.`;
  }
};

// `digest drain`: the per-thread lines, then what the run achieved. An aborted run
// says so on its own line, because "0 summarized" alone reads like a clean backlog.
export const drainReport = (result: DrainResult, limit: number): string[] => {
  if (result.outcomes.length === 0) return ["Nothing stale, the backlog is clean."];
  const lines = [`Draining up to ${limit} stale thread(s).`];
  for (const outcome of result.outcomes) lines.push(digestOutcomeLine(outcome));
  if (result.aborted) lines.push(`Drain aborted: ${result.aborted}`);
  lines.push(`Drain complete: ${result.summarized} summarized, ${result.failed} failed.`);
  return lines;
};

// The accepted shape of the JSON a SessionEnd hook pipes to `digest run --stdin`
// (Claude Code sends { session_id, ... }). Extra keys are ignored. This is the
// third untrusted I/O boundary, and it replaces a sed that scraped the id out of
// the payload with a regex in the hook script.
const SessionEndPayloadSchema = v.object({ session_id: v.optional(v.string()) });

// Pull the session id out of that payload, pure over the already-read raw string
// so it is unit-testable without fd-0 plumbing. Returns null on any parse or
// validation failure, and the caller reports a missing id rather than summarizing
// something arbitrary.
export const parseSessionEndPayload = (raw: string): string | null => {
  try {
    const parsed = v.safeParse(SessionEndPayloadSchema, JSON.parse(raw));
    if (!parsed.success) return null;
    return parsed.output.session_id || null;
  } catch {
    return null;
  }
};

// How many stale threads one `digest drain` summarizes when --limit is absent.
// Matches the reconciler's own default cap.
const DEFAULT_DRAIN_LIMIT = 8;

// The `digest` command: dispatch over its action sub-commands
// (stale | prompt | input | model | run | drain | write | search | show).
export const digestCommand = (ctx: CommandContext): void => {
  const { db, io, values, positionals, limit, fail, emitJson } = ctx;
  const action = positionals[1];
  switch (action) {
    case "prompt":
      io.log(DIGEST_PROMPT);
      break;

    case "input": {
      const sessionId = resolveOrFail(db, positionals[2], "digest input", fail);
      if (!sessionId) break;
      // The size-bounded transcript fed to `claude -p`. Written raw to stdout
      // (no trailing newline of our own) so it pipes straight into the model.
      io.write(buildDigestInput(threadMessages(db, sessionId)));
      break;
    }

    case "model": {
      // --bytes N tiers on an already-measured size: the hooks render the
      // transcript once with `digest input`, `wc -c` it for logging anyway,
      // and pass that here, so the transcript is not rendered a second time
      // just to be measured.
      const bytes = numberOption(
        values.bytes,
        "bytes",
        { integer: true, min: 0, label: "a non-negative integer" },
        fail,
      );
      if (!bytes.ok) break;
      if (bytes.value !== undefined) {
        io.log(pickDigestModel(bytes.value));
        break;
      }
      const sessionId = resolveOrFail(db, positionals[2], "digest model", fail);
      if (!sessionId) break;
      // The model the summarize hook would pick for this thread, by the byte
      // size of its rendered transcript (matching the hook's `wc -c`). cerebro
      // owns the tiering; the hook asks instead of hardcoding the threshold.
      const input = buildDigestInput(threadMessages(db, sessionId));
      io.log(pickDigestModel(Buffer.byteLength(input, "utf8")));
      break;
    }

    case "stale": {
      const rows = staleThreads(db, limit ?? 50);
      if (values.json) {
        emitJson(rows);
        break;
      }
      // --ids: the machine mode (see staleIds above). Empty output means nothing
      // is stale.
      if (values.ids) {
        for (const line of staleIds(rows)) io.log(line);
        break;
      }
      if (rows.length === 0) {
        io.log("All threads are summarized and up to date.");
        break;
      }
      for (const line of staleListing(rows, { promptVersion: DIGEST_PROMPT_VERSION })) {
        io.log(line);
      }
      break;
    }

    case "run": {
      // --stdin takes the id from the SessionEnd payload, so the clear hook needs
      // neither jq nor a sed over untrusted JSON.
      const idArg = values.stdin ? parseSessionEndPayload(readStdin()) : positionals[2];
      if (values.stdin && !idArg) {
        fail("digest run: no session_id in the payload on stdin");
        break;
      }
      const sessionId = resolveOrFail(db, idArg ?? undefined, "digest run", fail);
      if (!sessionId) break;
      const outcome = runDigest(db, sessionId);
      io.log(digestOutcomeLine(outcome));
      // Exit 1 whenever no summary was stored, so a manual invocation is
      // scriptable. The clear hook is detached and ignores this.
      if (outcome.status !== "summarized") io.setExitCode(1);
      break;
    }

    case "drain": {
      const cap = limit ?? DEFAULT_DRAIN_LIMIT;
      const result = runDrain(db, cap);
      for (const line of drainReport(result, cap)) io.log(line);
      // Per-thread failures are normal and leave the thread stale for next time;
      // only a run that could not proceed at all is an error.
      if (result.aborted) io.setExitCode(1);
      break;
    }

    case "write": {
      const sessionId = resolveOrFail(db, positionals[2], "digest write", fail);
      if (!sessionId) break;
      const text = readStdin().trim();
      if (!text) {
        fail("digest write: no summary text on stdin");
        break;
      }
      // Refuse to store output that cannot be a summary (an error message, a
      // fragment). The thread stays stale, so the reconciler retries it.
      const reason = rejectSummaryReason(text);
      if (reason) {
        fail(`digest write: rejected: ${reason}`);
        break;
      }
      const root = writeSummary(db, sessionId, text, values.model ?? null);
      io.log(summarySaved(root, text.length));
      break;
    }

    case "search": {
      const query = positionals.slice(2).join(" ");
      if (!query) {
        fail("digest search: missing <query>");
        break;
      }
      const hits = searchSummaries(db, query, limit ?? 10);
      present(ctx, hits, { lines: summarySearchListing, empty: "No matching summaries." });
      break;
    }

    case "show": {
      const sessionId = resolveOrFail(db, positionals[2], "digest show", fail);
      if (!sessionId) break;
      const summary = getSummary(db, sessionId);
      if (values.json) {
        emitJson(summary);
        break;
      }
      if (!summary) {
        io.log(noSummaryHint(sessionId));
        break;
      }
      for (const line of digestShow(summary)) io.log(line);
      break;
    }

    default:
      fail(
        `digest: unknown action "${action ?? ""}". ` +
          "Use: stale | run <id> | drain | prompt | input <id> | model <id> | write <id> | " +
          "search <query> | show <id>",
      );
  }
};
