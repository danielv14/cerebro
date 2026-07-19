import {
  buildDigestInput,
  DIGEST_PROMPT,
  DIGEST_PROMPT_VERSION,
  getSummary,
  pickDigestModel,
  rejectSummaryReason,
  type StaleThread,
  type StoredSummary,
  type SummaryHit,
  searchSummaries,
  staleThreads,
  writeSummary,
} from "../digest/index.ts";
import { oneLine, projectName, shortId, shortTime } from "../render.ts";
import { threadMessages } from "../thread.ts";
import { type CommandContext, readStdin, resolveOrFail } from "./context.ts";

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
      `  cerebro digest input <id> | claude -p "$(cerebro digest prompt)" | cerebro digest write <id>`,
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

// The `digest` command: dispatch over its action sub-commands
// (stale | prompt | input | model | write | search | show).
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
      if (values.bytes !== undefined) {
        const bytes = Number(values.bytes);
        if (!Number.isInteger(bytes) || bytes < 0) {
          fail(`--bytes must be a non-negative integer (got "${values.bytes}")`);
          break;
        }
        io.log(pickDigestModel(bytes));
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
      if (values.json) {
        emitJson(hits);
        break;
      }
      if (hits.length === 0) {
        io.log("No matching summaries.");
        break;
      }
      for (const line of summarySearchListing(hits)) io.log(line);
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
          "Use: stale | prompt | input <id> | model <id> | write <id> | search <query> | show <id>",
      );
  }
};
