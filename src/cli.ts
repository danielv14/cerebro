#!/usr/bin/env bun
import type { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import * as v from "valibot";
import { runBackup } from "./backup.ts";
import { type CliIO, type CommandContext, resolveOrFail } from "./commands/context.ts";
import { runDigest } from "./commands/digest.ts";
import { openDb } from "./db.ts";
import { countStaleThreads } from "./digest.ts";
import { gitInfo } from "./git.ts";
import { HELP } from "./help.ts";
import { dryRunIndex, runIndex } from "./indexer.ts";
import { defaultDbPath } from "./paths.ts";
import { listThreads, recentThreads, relevantThreads, search, stats } from "./query.ts";
import {
  backupReport,
  dryRunReport,
  indexResult,
  rebuildResult,
  recentBlock,
  relevantBlock,
  searchListing,
  sessionsListing,
  showFull,
  showOutline,
  showRange,
  statsReport,
} from "./render.ts";
import { threadMessages, threadOpeningPrompt } from "./thread.ts";

export type { CliIO } from "./commands/context.ts";

const realIO: CliIO = {
  log: (line) => process.stdout.write(`${line}\n`),
  error: (line) => process.stderr.write(`${line}\n`),
  write: (text) => process.stdout.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  },
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

  // --json: emit the typed rows as a JSON document instead of the human listing.
  // A far more robust contract for agents and scripts than the pinned column
  // widths; empty results emit an empty array/object rather than prose.
  const emitJson = (payload: unknown): void => io.log(JSON.stringify(payload, null, 2));

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
          range: { type: "string" },
          to: { type: "string" },
          keep: { type: "string" },
          json: { type: "boolean", default: false },
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
  // Opening can fail (permissions, corrupt file, a lost migration race): report it
  // like any other error instead of escaping runCli as an unhandled stack trace.
  let db: Database;
  try {
    db = makeDb(dbPath);
  } catch (error) {
    fail(`could not open database at ${dbPath}: ${(error as Error).message}`);
    return;
  }

  // The context handed to the extracted command handlers under src/commands/:
  // everything a handler needs, so handlers never import from cli.ts.
  const ctx: CommandContext = { db, io, values, positionals, dbPath, limit, fail, emitJson };

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
        // Anchored shape check plus a round-trip calendar check: an unanchored
        // regex would let "2026-31-01" or trailing garbage through, and Date.parse
        // alone is engine-dependent (JSC rolls "2026-02-30" over to March 2). A
        // bad date would make the lexical ts comparison silently exclude
        // everything instead of erroring.
        if (values.since !== undefined) {
          const parsed = Date.parse(`${values.since}T00:00:00Z`);
          const roundTrips =
            /^\d{4}-\d{2}-\d{2}$/.test(values.since) &&
            !Number.isNaN(parsed) &&
            new Date(parsed).toISOString().slice(0, 10) === values.since;
          if (!roundTrips) {
            fail(`--since must be a valid ISO date like 2026-01-31 (got "${values.since}")`);
            break;
          }
        }
        const hits = search(db, query, limit ?? 20, {
          project: values.project,
          since: values.since,
          all: values.all,
        });
        if (values.json) {
          emitJson(hits);
          break;
        }
        if (hits.length === 0) {
          io.log("No matches.");
          break;
        }
        for (const line of searchListing(hits, { all: values.all })) io.log(line);
        break;
      }

      case "sessions": {
        const threads = listThreads(db, { project: values.project, limit: limit ?? 30 });
        if (values.json) {
          emitJson(threads);
          break;
        }
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

        if (values.json) {
          emitJson(
            threads.map((thread) => ({ ...thread, opening: threadOpeningPrompt(db, thread.id) })),
          );
          break;
        }

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
        if (values.json) {
          emitJson(threads);
          break;
        }
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

        // --range is resolved (and validated) BEFORE the output format is chosen,
        // so `--range A..B --json` returns the requested slice as JSON instead of
        // silently dumping the whole thread.
        let slice = messages;
        let from = 1;
        if (values.range !== undefined) {
          // --range A..B (or a single N): a verbatim slice in outline numbering,
          // the jump target for search's #N ordinals.
          const match = values.range.match(/^(\d+)(?:\.\.(\d+))?$/);
          const start = match ? Number(match[1]) : 0;
          const to = match?.[2] ? Number(match[2]) : start;
          if (!match || start < 1 || to < start) {
            fail(`--range must be N or A..B with 1 <= A <= B (got "${values.range}")`);
            break;
          }
          if (start > messages.length) {
            fail(`--range starts at ${start} but the thread has ${messages.length} message(s)`);
            break;
          }
          from = start;
          slice = messages.slice(start - 1, Math.min(to, messages.length));
        }

        if (values.json) {
          emitJson({ id: sessionId, total: messages.length, from, messages: slice });
          break;
        }
        if (values.range !== undefined) {
          for (const line of showRange(sessionId, slice, { from, total: messages.length })) {
            io.log(line);
          }
          break;
        }
        const lines = values.full
          ? showFull(sessionId, messages)
          : showOutline(sessionId, messages);
        for (const line of lines) io.log(line);
        break;
      }

      case "digest": {
        runDigest(ctx);
        break;
      }

      case "stats": {
        // The file size lives outside the query layer (and is meaningless for the
        // in-memory databases tests use); the stale count is the digest layer's,
        // since staleness depends on DIGEST_PROMPT_VERSION.
        let dbBytes: number | null = null;
        try {
          dbBytes = statSync(dbPath).size;
        } catch {
          dbBytes = null;
        }
        const stale = countStaleThreads(db);
        if (values.json) {
          emitJson({ ...stats(db), dbBytes, staleThreads: stale });
          break;
        }
        for (const line of statsReport(stats(db), { dbBytes, staleThreads: stale })) {
          io.log(line);
        }
        break;
      }

      case "maintain": {
        // Periodic housekeeping: the FTS indexes are fed by thousands of tiny
        // incremental transactions and fragment over time; 'optimize' merges their
        // b-trees. PRAGMA optimize refreshes the query planner's stats, and the
        // truncating checkpoint folds the WAL back into the main file.
        db.run("INSERT INTO messages_fts(messages_fts) VALUES('optimize')");
        db.run("INSERT INTO summaries_fts(summaries_fts) VALUES('optimize')");
        db.run("PRAGMA optimize");
        db.run("PRAGMA wal_checkpoint(TRUNCATE)");
        io.log("Maintenance done: FTS indexes optimized, planner stats refreshed, WAL truncated.");
        break;
      }

      case "backup": {
        let keep: number | undefined;
        if (values.keep !== undefined) {
          keep = Number(values.keep);
          if (!Number.isInteger(keep) || keep < 1) {
            fail(`--keep must be a positive integer (got "${values.keep}")`);
            break;
          }
        }
        for (const line of backupReport(runBackup(db, dbPath, { to: values.to, keep }))) {
          io.log(line);
        }
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
