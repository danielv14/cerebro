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
import { CliError, flag, numeric, type OptionTable, positiveInt, text } from "./args.ts";
import { type CommandGroup, defineCommand } from "./command.ts";
import { readStdin, resolveOrThrow } from "./helpers.ts";

// `promptVersion` is passed in so this stays free of the staleness query's
// versioning.
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

// Machine mode for the batch hook: one full session id per line, nothing else, so
// a caller never scrapes the human listing format.
export const staleIds = (rows: StaleThread[]): string[] => rows.map((row) => row.id);

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

export const digestShow = (summary: StoredSummary): string[] => {
  const model = summary.model ? `, ${summary.model}` : "";
  return [
    `Summary for thread ${shortId(summary.root_session_id)}  ` +
      `(${shortTime(summary.summarized_at)}${model}, prompt v${summary.prompt_version})\n`,
    summary.summary,
  ];
};

export const noSummaryHint = (sessionId: string): string =>
  `No summary yet for ${shortId(sessionId)}. Generate the backlog with: cerebro digest stale`;

export const summarySaved = (root: string, chars: number): string =>
  `Saved summary for thread ${shortId(root)} (${chars} chars).`;

// Both the hooks' logs and a human read these, so a failure always names the
// reason and says the thread is not lost.
export const digestOutcomeLine = (outcome: DigestOutcome): string => {
  const id = shortId(outcome.root);
  switch (outcome.status) {
    case "summarized":
      return `Summarized ${id}: ${outcome.chars} chars stored.`;
    case "skipped":
      // No retry promise here: the only way to skip is an empty transcript, and
      // the `threads` view keeps zero-message threads out of the stale list.
      return `Skipped ${id}: ${outcome.reason}.`;
    default:
      return `Failed ${id}: ${outcome.reason}; left unsummarized, digest drain will retry it.`;
  }
};

// Printed before the model is called: a wedged call leaves this line behind, which
// is the whole point.
export const digestStartLine = (about: { root: string; bytes: number; model: string }): string =>
  `Summarizing ${shortId(about.root)}: ${about.bytes} bytes -> ${about.model}`;

// An aborted run says so on its own line, because "0 summarized" alone reads like
// a clean backlog.
export const drainSummary = (result: DrainResult): string[] => {
  if (result.outcomes.length === 0) return ["Nothing stale, the backlog is clean."];
  const lines: string[] = [];
  if (result.aborted) lines.push(`Drain aborted: ${result.aborted}`);
  const skipped = result.skipped > 0 ? `, ${result.skipped} skipped` : "";
  lines.push(`Drain complete: ${result.summarized} summarized, ${result.failed} failed${skipped}.`);
  return lines;
};

// The JSON a SessionEnd hook pipes to `digest run --stdin` (Claude Code sends
// { session_id, ... }); an untrusted I/O boundary. Extra keys are ignored.
const SessionEndPayloadSchema = v.object({ session_id: v.optional(v.string()) });

// Pure over the already-read raw string so it is unit-testable without fd-0
// plumbing. Returns null on any parse or validation failure, and the caller
// reports a missing id rather than summarizing something arbitrary.
export const parseSessionEndPayload = (raw: string): string | null => {
  try {
    const parsed = v.safeParse(SessionEndPayloadSchema, JSON.parse(raw));
    if (!parsed.success) return null;
    return parsed.output.session_id || null;
  } catch {
    return null;
  }
};

// Matches the reconciler's own default cap.
const DEFAULT_DRAIN_LIMIT = 8;

const limitOption = positiveInt();

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
          // --ids: empty output means nothing is stale, which is what the
          // reconciler's guard reads.
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
      run: ({ db, args, rest, progress }) => {
        // --stdin takes the id from the SessionEnd payload, so the clear hook
        // needs neither jq nor a sed over untrusted JSON.
        const idArg = args.stdin ? parseSessionEndPayload(readStdin()) : rest[0];
        if (args.stdin && !idArg) {
          throw new CliError("digest run: no session_id in the payload on stdin");
        }
        const outcome = runDigest(db, resolveOrThrow(db, idArg ?? undefined, "digest run"), {
          onStart: (about) => progress(digestStartLine(about)),
        });
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
      run: ({ db, args, progress }) => {
        const cap = args.limit ?? DEFAULT_DRAIN_LIMIT;
        // Reported per thread as it completes: a drain makes up to `cap` model
        // calls and the reconciler's only witness is digest.log.
        const result = runDrain(db, cap, {
          onStart: (count) => progress(`Draining up to ${cap} stale thread(s): ${count} to do.`),
          onThreadStart: (about) => progress(digestStartLine(about)),
          onOutcome: (outcome) => progress(digestOutcomeLine(outcome)),
        });
        return {
          lines: drainSummary(result),
          // Per-thread failures are normal and leave the thread stale for next
          // time; only a run that could not proceed at all is an error.
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
      // Raw stdout with no trailing newline of our own, so it pipes straight into
      // a model call.
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
        // Refuse to store output that cannot be a summary; the thread stays stale,
        // so the reconciler retries it.
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
