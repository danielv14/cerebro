#!/usr/bin/env bun
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import * as v from "valibot";
import { openDb } from "./db.ts";
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
} from "./digest.ts";
import { gitInfo } from "./git.ts";
import { dryRunIndex, runIndex } from "./indexer.ts";
import { defaultDbPath } from "./paths.ts";
import {
  listThreads,
  recentThreads,
  relevantThreads,
  resolveSession,
  search,
  stats,
} from "./query.ts";
import {
  digestShow,
  dryRunReport,
  indexResult,
  noSummaryHint,
  rebuildResult,
  recentBlock,
  relevantBlock,
  searchListing,
  sessionsListing,
  showFull,
  showOutline,
  staleIds,
  staleListing,
  statsReport,
  summarySaved,
  summarySearchListing,
} from "./render.ts";
import { threadMessages, threadOpeningPrompt } from "./thread.ts";

const HELP = `cerebro - permanent verbatim archive + search over Claude Code sessions

Usage:
  cerebro index [--full] [--rebuild] [--dry-run]   Index all sessions incrementally
  cerebro search <query> [--limit N] [--project P] [--since D] [--all]
                                         Full-text search (ranked, best hit per thread;
                                         --all for every matching message)
  cerebro sessions [--project P] [--limit N]   List threads, newest first
  cerebro recent [--cwd P] [--days D] [--limit N] [--context]   Recent threads for one repo
  cerebro relevant <prompt> [--limit N] [--context]   Past threads relevant to a prompt
  cerebro show <session-id> [--full]     Show a thread (outline, or full transcript)
  cerebro stats                          Archive counts
  cerebro digest <action>                Curated session summaries (see below)

Digest actions:
  cerebro digest stale [--limit N] [--ids]    List threads needing a (re)summary
  cerebro digest prompt                       Print the summarization prompt
  cerebro digest input <id>                   Print the size-bounded transcript to summarize
  cerebro digest model <id> | --bytes N       Print the model the size tiering would pick
  cerebro digest write <id> [--model M]       Store a summary for a thread (reads it from stdin)
  cerebro digest search <query> [--limit N]   Full-text search the summaries
  cerebro digest show <id>                    Print a thread's stored summary

  cerebro is pure storage and never calls an LLM. A hook or skill produces the
  summary and writes it back, e.g.:
    cerebro digest input <id> | claude -p "$(cerebro digest prompt)" | cerebro digest write <id>

Options:
  --db <path>     Database file (default: $CEREBRO_DB or ~/.claude/cerebro/archive.sqlite)
  --full          index: ignore cursors and re-read everything (dedup skips known
                  messages, so stored text is never touched); show: print full text
  --rebuild       index: like --full, but also re-flatten the stored text of every
                  message still on disk (needed after a flattening/parser change;
                  messages whose source file is deleted are kept untouched)
  --dry-run       index: report what would be indexed, write nothing
  --limit <n>     Max rows to return
  --project <p>   sessions/search: filter by project path substring
  --since <date>  search: only messages at or after this ISO date (e.g. 2026-01-31)
  --all           search: every matching message instead of the best hit per thread
  --cwd <path>    recent: directory to scope by (default: current dir)
  --days <n>      recent: only threads active within the last n days (default 14)
  --context       recent/relevant: emit an agent-facing context block (for a hook)
  --stdin         relevant: read the prompt from a hook's JSON payload on stdin
  --ids           digest stale: print one full session id per line (for scripts)
  --model <name>  digest write: record which model produced the summary
  --bytes <n>     digest model: tier by an already-measured transcript byte count
                  (skips re-rendering the transcript; used by the hooks)
  -h, --help      Show this help

Env:
  CEREBRO_DB           Override the database path
  CEREBRO_CLAUDE_DIR   Override the ~/.claude directory`;

// Output sink for the CLI. Routing every line through this (instead of calling
// console / process directly inside the dispatch) is what makes runCli testable:
// a test passes a capturing sink and asserts on the lines and exit code without
// spawning the binary or mutating the global process.exitCode.
export interface CliIO {
  log: (line: string) => void; // a normal output line (stdout + newline)
  error: (line: string) => void; // an error line (stderr + newline)
  write: (text: string) => void; // raw stdout, no trailing newline (digest input)
  setExitCode: (code: number) => void;
}

const realIO: CliIO = {
  log: (line) => process.stdout.write(`${line}\n`),
  error: (line) => process.stderr.write(`${line}\n`),
  write: (text) => process.stdout.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

// Resolve a positional session-id argument (an id or a unique prefix) to a full
// session id, reporting the right error and setting exit 1 when it is missing or
// matches nothing. Returns null in those cases so the caller can stop. The five
// id-taking commands (show, digest input/model/write/show) share this instead of
// each re-checking the argument. An ambiguous prefix still throws from
// resolveSession and is caught by runCli's outer handler, as before.
const resolveOrFail = (
  db: Database,
  idArg: string | undefined,
  label: string,
  fail: (message: string) => void,
): string | null => {
  if (!idArg) {
    fail(`${label}: missing <session-id>`);
    return null;
  }
  const sessionId = resolveSession(db, idArg);
  if (!sessionId) {
    fail(`No session matching "${idArg}".`);
    return null;
  }
  return sessionId;
};

// The accepted shape of the JSON a UserPromptSubmit hook pipes to `relevant
// --stdin` (the hook sends { prompt, cwd, ... }). Only `prompt` is read; extra keys
// are ignored.
const HookPayloadSchema = v.object({ prompt: v.optional(v.string()) });

// Validate that hook stdin payload, pure over the already-read raw string so it is
// unit-testable without fd-0 plumbing. Degrades to an empty prompt on any JSON-parse
// or validation failure (malformed JSON, missing prompt, non-string prompt), exactly
// as the previous inline cast did, so a broken payload never injects context or
// spams the prompt. This is cerebro's second untrusted I/O boundary (the first is the
// session JSONL in jsonl.ts).
export const parseHookPayload = (raw: string): { prompt: string } => {
  try {
    // HookPayloadSchema validates prompt as optional(string), so on success it is
    // string | undefined (never null); ?? "" covers the missing case.
    const parsed = v.safeParse(HookPayloadSchema, JSON.parse(raw));
    return { prompt: parsed.success ? (parsed.output.prompt ?? "") : "" };
  } catch {
    return { prompt: "" };
  }
};

// Parse args, dispatch the command, and report through `io`. `makeDb` is injected
// so tests can supply an in-memory database; production passes openDb. runCli owns
// the database lifetime (open after the help/parse fast-paths, close in finally).
export const runCli = (
  args: string[],
  io: CliIO,
  makeDb: (path: string) => Database = openDb,
): void => {
  const fail = (message: string): void => {
    io.error(message);
    io.setExitCode(1);
  };

  // parseArgs throws on unknown options; turn that into a clean message + exit 1
  // instead of a raw stack trace. The IIFE preserves parseArgs's inferred types.
  const parsed = (() => {
    try {
      return parseArgs({
        args,
        allowPositionals: true,
        options: {
          db: { type: "string" },
          full: { type: "boolean", default: false },
          rebuild: { type: "boolean", default: false },
          "dry-run": { type: "boolean", default: false },
          limit: { type: "string" },
          project: { type: "string" },
          cwd: { type: "string" },
          days: { type: "string" },
          since: { type: "string" },
          all: { type: "boolean", default: false },
          context: { type: "boolean", default: false },
          stdin: { type: "boolean", default: false },
          ids: { type: "boolean", default: false },
          model: { type: "string" },
          bytes: { type: "string" },
          help: { type: "boolean", short: "h", default: false },
        },
      });
    } catch (error) {
      fail((error as Error).message);
      return null;
    }
  })();
  if (!parsed) return;
  const { values, positionals } = parsed;

  const command = positionals[0];

  if (values.help || !command) {
    io.log(HELP);
    return;
  }

  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      fail(`--limit must be a positive integer (got "${values.limit}")`);
      return;
    }
  }

  const dbPath = values.db || defaultDbPath();
  const db = makeDb(dbPath);

  try {
    switch (command) {
      case "index": {
        if (values["dry-run"]) {
          // A rebuild reads exactly what --full reads; the dry run reports that plan.
          for (const line of dryRunReport(dryRunIndex(db, values.full || values.rebuild))) {
            io.log(line);
          }
          break;
        }
        if (values.rebuild) {
          for (const line of rebuildResult(runIndex(db, false, true))) io.log(line);
          break;
        }
        for (const line of indexResult(runIndex(db, values.full))) io.log(line);
        break;
      }

      case "search": {
        const query = positionals.slice(1).join(" ");
        if (!query) {
          fail("search: missing <query>");
          break;
        }
        if (values.since && !/^\d{4}-\d{2}-\d{2}/.test(values.since)) {
          fail(`--since must be an ISO date like 2026-01-31 (got "${values.since}")`);
          break;
        }
        const hits = search(db, query, limit ?? 20, {
          project: values.project,
          since: values.since,
          all: values.all,
        });
        if (hits.length === 0) {
          io.log("No matches.");
          break;
        }
        for (const line of searchListing(hits, { all: values.all })) io.log(line);
        break;
      }

      case "sessions": {
        const threads = listThreads(db, { project: values.project, limit: limit ?? 30 });
        if (threads.length === 0) {
          io.log("No sessions indexed yet. Run: cerebro index");
          break;
        }
        for (const line of sessionsListing(threads)) io.log(line);
        break;
      }

      case "recent": {
        const cwd = values.cwd || process.cwd();
        const days = values.days ? Number(values.days) : 14;
        if (!Number.isFinite(days) || days <= 0) {
          fail(`--days must be a positive number (got "${values.days}")`);
          break;
        }
        const since = new Date(Date.now() - days * 86_400_000).toISOString();
        const repoRoot = gitInfo(cwd).root;
        const threads = recentThreads(db, { repoRoot, cwd, since, limit: limit ?? 5 });

        if (threads.length === 0) {
          // Silent in --context mode so the SessionStart hook injects nothing.
          if (!values.context) io.log("No recent sessions for this repo.");
          break;
        }

        // Fetch the opening prompt per thread here so render stays db-free.
        const rows = threads.map((thread) => ({
          thread,
          opening: threadOpeningPrompt(db, thread.id),
        }));
        for (const line of recentBlock(rows, {
          repoPath: repoRoot ?? cwd,
          days,
          context: values.context,
        })) {
          io.log(line);
        }
        break;
      }

      case "relevant": {
        // --stdin reads the prompt from a hook's JSON payload (UserPromptSubmit
        // sends { prompt, cwd, ... } on stdin), so the hook needs no jq or wrapper.
        let prompt = positionals.slice(1).join(" ");
        if (values.stdin) {
          // The fd-0 read is the only impure step; the parsing/validation is in the
          // pure parseHookPayload. A failed read (no stdin) degrades to "" too.
          let raw = "";
          try {
            raw = readFileSync(0, "utf8");
          } catch {
            raw = "";
          }
          prompt = parseHookPayload(raw).prompt;
        }
        if (!prompt) {
          if (!values.context) {
            io.error("relevant: missing <prompt>");
            io.setExitCode(1);
          }
          break;
        }
        const threads = relevantThreads(db, prompt, limit ?? 3);
        if (threads.length === 0) {
          // Silent in --context mode so the UserPromptSubmit hook injects nothing.
          if (!values.context) io.log("No related past sessions.");
          break;
        }
        for (const line of relevantBlock(threads, { context: values.context })) io.log(line);
        break;
      }

      case "show": {
        const sessionId = resolveOrFail(db, positionals[1], "show", fail);
        if (!sessionId) break;
        const messages = threadMessages(db, sessionId);
        const lines = values.full
          ? showFull(sessionId, messages)
          : showOutline(sessionId, messages);
        for (const line of lines) io.log(line);
        break;
      }

      case "digest": {
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
        break;
      }

      case "stats": {
        for (const line of statsReport(stats(db))) io.log(line);
        break;
      }

      default:
        io.error(`Unknown command: ${command}\n`);
        io.log(HELP);
        io.setExitCode(1);
    }
  } catch (error) {
    // e.g. an ambiguous session prefix or an unexpected SQL error: show the
    // message, not a stack trace.
    fail((error as Error).message);
  } finally {
    db.close();
  }
};

const main = (): void => {
  runCli(Bun.argv.slice(2), realIO);
};

// Only dispatch when run as the entry point; importing this module (e.g. from a
// test that drives runCli directly) must not execute a command.
if (import.meta.main) main();
