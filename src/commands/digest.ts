import { readFileSync } from "node:fs";
import {
  buildDigestInput,
  DIGEST_PROMPT,
  DIGEST_PROMPT_VERSION,
  getSummary,
  pickDigestModel,
  rejectSummaryReason,
  searchSummaries,
  staleThreads,
  writeSummary,
} from "../digest.ts";
import {
  digestShow,
  noSummaryHint,
  staleIds,
  staleListing,
  summarySaved,
  summarySearchListing,
} from "../render.ts";
import { threadMessages } from "../thread.ts";
import { type CommandContext, resolveOrFail } from "./context.ts";

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
      // owns the tiering so the hook no longer hardcodes the threshold.
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
      // --ids: machine-readable mode for scripts (the digest-stale batch hook).
      // One full session id per line, nothing else (no header, titles, or help
      // footer), so a caller never has to scrape the human listing format. Empty
      // output means nothing is stale. Full ids, not shortId, so the caller skips
      // the prefix round-trip.
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
      let text = "";
      try {
        text = readFileSync(0, "utf8").trim();
      } catch {
        text = "";
      }
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
