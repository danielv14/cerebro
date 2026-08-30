import * as v from "valibot";
import {
  buildDigestInput,
  createClaudeSummarizer,
  DIGEST_PROMPT,
  DIGEST_PROMPT_VERSION,
  type DigestOutcome,
  type DrainResult,
  digestConfigFromEnv,
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

// Machine mode for the batch hook: full ids only, so a caller never scrapes the
// human listing format.
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

export const digestOutcomeLine = (outcome: DigestOutcome): string => {
  const id = shortId(outcome.root);
  switch (outcome.status) {
    case "summarized":
      return `Summarized ${id}: ${outcome.chars} chars stored.`;
    case "skipped":
      // No retry promise: the only skip is an empty transcript, which the
      // threads view keeps out of the stale list entirely.
      return `Skipped ${id}: ${outcome.reason}.`;
    default:
      return `Failed ${id}: ${outcome.reason}; left unsummarized, digest drain will retry it.`;
  }
};

// Printed before the model call, so a wedged call still leaves this line behind.
export const digestStartLine = (about: { root: string; bytes: number; model: string }): string =>
  `Summarizing ${shortId(about.root)}: ${about.bytes} bytes -> ${about.model}`;

export const drainSummary = (result: DrainResult): string[] => {
  if (result.outcomes.length === 0) return ["Nothing stale, the backlog is clean."];
  const lines: string[] = [];
  // Its own line: "0 summarized" alone reads like a clean backlog.
  if (result.aborted) lines.push(`Drain aborted: ${result.aborted}`);
  const skipped = result.skipped > 0 ? `, ${result.skipped} skipped` : "";
  lines.push(`Drain complete: ${result.summarized} summarized, ${result.failed} failed${skipped}.`);
  return lines;
};

// Untrusted I/O boundary: the SessionEnd payload on stdin. Extra keys ignored.
const SessionEndPayloadSchema = v.object({ session_id: v.optional(v.string()) });

// null on any parse or validation failure: the caller reports a missing id
// rather than summarizing something arbitrary.
export const parseSessionEndPayload = (raw: string): string | null => {
  try {
    const parsed = v.safeParse(SessionEndPayloadSchema, JSON.parse(raw));
    if (!parsed.success) return null;
    return parsed.output.session_id || null;
  } catch {
    return null;
  }
};

// Matches the reconciler's default cap.
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
        const idArg = args.stdin ? parseSessionEndPayload(readStdin()) : rest[0];
        if (args.stdin && !idArg) {
          throw new CliError("digest run: no session_id in the payload on stdin");
        }
        const config = digestConfigFromEnv();
        const outcome = runDigest(db, resolveOrThrow(db, idArg ?? undefined, "digest run"), {
          summarize: createClaudeSummarizer(config),
          models: config.models,
          onStart: (about) => progress(digestStartLine(about)),
        });
        return {
          lines: [digestOutcomeLine(outcome)],
          // Exit 1 whenever no summary was stored, so a manual invocation is
          // scriptable; the detached clear hook ignores it.
          exitCode: outcome.status === "summarized" ? 0 : 1,
        };
      },
    }),

    drain: defineCommand({
      options: { limit: limitOption } satisfies OptionTable,
      run: ({ db, args, progress }) => {
        const cap = args.limit ?? DEFAULT_DRAIN_LIMIT;
        const config = digestConfigFromEnv();
        const result = runDrain(db, cap, {
          summarize: createClaudeSummarizer(config),
          models: config.models,
          onStart: (count) => progress(`Draining up to ${cap} stale thread(s): ${count} to do.`),
          onThreadStart: (about) => progress(digestStartLine(about)),
          onOutcome: (outcome) => progress(digestOutcomeLine(outcome)),
        });
        return {
          lines: drainSummary(result),
          // Per-thread failures are normal (the thread stays stale); only a run
          // that could not proceed at all is an error.
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
      run: ({ db, rest }) => ({
        raw: buildDigestInput(threadMessages(db, resolveOrThrow(db, rest[0], "digest input"))),
      }),
    }),

    model: defineCommand({
      options: {
        bytes: numeric({ integer: true, min: 0, label: "a non-negative integer" }),
      } satisfies OptionTable,
      run: ({ db, args, rest }) => {
        const { models } = digestConfigFromEnv();
        if (args.bytes !== undefined) return { lines: [pickDigestModel(args.bytes, models)] };
        const input = buildDigestInput(
          threadMessages(db, resolveOrThrow(db, rest[0], "digest model")),
        );
        return { lines: [pickDigestModel(Buffer.byteLength(input, "utf8"), models)] };
      },
    }),

    write: defineCommand({
      options: { model: text() } satisfies OptionTable,
      run: ({ db, args, rest }) => {
        const sessionId = resolveOrThrow(db, rest[0], "digest write");
        const summary = readStdin().trim();
        if (!summary) throw new CliError("digest write: no summary text on stdin");
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
