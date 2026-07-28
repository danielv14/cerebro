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
import { CliError, flag, numeric, type OptionTable, text } from "./args.ts";
import { type CommandGroup, defineCommand } from "./command.ts";
import { readStdin, resolveOrThrow } from "./helpers.ts";

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

const limitOption = numeric({ integer: true, min: 1, label: "a positive integer" });

// `digest` is a group: each action declares the flags it accepts, so
// `digest search --bytes 5` is rejected the same way an unknown flag on a
// top-level command is, and each action's arguments arrive validated.
export const digestCommand: CommandGroup = {
  unknownAction: (action) =>
    `digest: unknown action "${action ?? ""}". ` +
    "Use: stale | run <id> | drain | prompt | input <id> | model <id> | write <id> | " +
    "search <query> | show <id>",

  subcommands: {
    stale: defineCommand({
      options: { limit: limitOption, ids: flag(), json: flag() } satisfies OptionTable,
      run: ({ db, args }) => {
        const rows = staleThreads(db, args.limit ?? 50);
        return {
          json: rows,
          // --ids is the machine mode: full ids, one per line, no header, titles or
          // footer, so a caller never scrapes the human listing. Empty output means
          // nothing is stale, which is what the reconciler's guard reads.
          lines: args.ids
            ? staleIds(rows)
            : rows.length > 0
              ? staleListing(rows, { promptVersion: DIGEST_PROMPT_VERSION })
              : [],
          empty: args.ids ? undefined : "All threads are summarized and up to date.",
        };
      },
    }),

    run: defineCommand({
      options: { stdin: flag() } satisfies OptionTable,
      run: ({ db, args, rest }) => {
        // --stdin takes the id from the SessionEnd payload, so the clear hook needs
        // neither jq nor a sed over untrusted JSON.
        const idArg = args.stdin ? parseSessionEndPayload(readStdin()) : rest[0];
        if (args.stdin && !idArg) {
          throw new CliError("digest run: no session_id in the payload on stdin");
        }
        const outcome = runDigest(db, resolveOrThrow(db, idArg ?? undefined, "digest run"));
        return {
          lines: [digestOutcomeLine(outcome)],
          // Exit 1 whenever no summary was stored, so a manual invocation is
          // scriptable. The clear hook is detached and ignores this.
          exitCode: outcome.status === "summarized" ? 0 : 1,
        };
      },
    }),

    drain: defineCommand({
      options: { limit: limitOption } satisfies OptionTable,
      run: ({ db, args }) => {
        const cap = args.limit ?? DEFAULT_DRAIN_LIMIT;
        const result = runDrain(db, cap);
        return {
          lines: drainReport(result, cap),
          // Per-thread failures are normal and leave the thread stale for next time;
          // only a run that could not proceed at all is an error.
          exitCode: result.aborted ? 1 : 0,
        };
      },
    }),

    prompt: defineCommand({
      options: {} satisfies OptionTable,
      run: () => ({ lines: [DIGEST_PROMPT] }),
    }),

    input: defineCommand({
      options: {} satisfies OptionTable,
      // The size-bounded transcript fed to the model. Raw stdout with no trailing
      // newline of our own, so it pipes straight into one.
      run: ({ db, rest }) => ({
        raw: buildDigestInput(threadMessages(db, resolveOrThrow(db, rest[0], "digest input"))),
      }),
    }),

    model: defineCommand({
      options: {
        bytes: numeric({ integer: true, min: 0, label: "a non-negative integer" }),
      } satisfies OptionTable,
      run: ({ db, args, rest }) => {
        // --bytes N tiers an already-measured size without rendering anything.
        if (args.bytes !== undefined) return { lines: [pickDigestModel(args.bytes)] };
        // Otherwise render the thread and tier on its size, for manual inspection.
        const input = buildDigestInput(
          threadMessages(db, resolveOrThrow(db, rest[0], "digest model")),
        );
        return { lines: [pickDigestModel(Buffer.byteLength(input, "utf8"))] };
      },
    }),

    write: defineCommand({
      options: { model: text() } satisfies OptionTable,
      run: ({ db, args, rest }) => {
        const sessionId = resolveOrThrow(db, rest[0], "digest write");
        const summary = readStdin().trim();
        if (!summary) throw new CliError("digest write: no summary text on stdin");
        // Refuse to store output that cannot be a summary (an error message, a
        // fragment). The thread stays stale, so the reconciler retries it.
        const rejected = rejectSummaryReason(summary);
        if (rejected) throw new CliError(`digest write: rejected: ${rejected}`);
        const root = writeSummary(db, sessionId, summary, args.model ?? null);
        return { lines: [summarySaved(root, summary.length)] };
      },
    }),

    search: defineCommand({
      options: { limit: limitOption, json: flag() } satisfies OptionTable,
      run: ({ db, args, rest }) => {
        const query = rest.join(" ");
        if (!query) throw new CliError("digest search: missing <query>");
        const hits = searchSummaries(db, query, args.limit ?? 10);
        return {
          json: hits,
          lines: hits.length > 0 ? summarySearchListing(hits) : [],
          empty: "No matching summaries.",
        };
      },
    }),

    show: defineCommand({
      options: { json: flag() } satisfies OptionTable,
      run: ({ db, rest }) => {
        const sessionId = resolveOrThrow(db, rest[0], "digest show");
        const summary = getSummary(db, sessionId);
        return {
          json: summary,
          lines: summary ? digestShow(summary) : [],
          empty: noSummaryHint(sessionId),
        };
      },
    }),
  },
};
