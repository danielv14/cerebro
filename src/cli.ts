#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { openDb } from "./db.ts";
import { defaultDbPath } from "./paths.ts";
import { runIndex, dryRunIndex } from "./indexer.ts";
import {
  search,
  listThreads,
  resolveSession,
  threadMessages,
  stats,
} from "./query.ts";

const HELP = `cerebro - permanent verbatim archive + search over Claude Code sessions

Usage:
  cerebro index [--full] [--dry-run]     Index all sessions incrementally
  cerebro search <query> [--limit N]     Full-text search (ranked, snippet-first)
  cerebro sessions [--project P] [--limit N]   List threads, newest first
  cerebro show <session-id> [--full]     Show a thread (outline, or full transcript)
  cerebro stats                          Archive counts

Options:
  --db <path>     Database file (default: $CEREBRO_DB or ~/.claude/cerebro/archive.sqlite)
  --full          index: ignore cursors and re-read everything; show: print full text
  --dry-run       index: report what would be indexed, write nothing
  --limit <n>     Max rows to return
  --project <p>   Filter sessions by project path substring
  -h, --help      Show this help

Env:
  CEREBRO_DB           Override the database path
  CEREBRO_CLAUDE_DIR   Override the ~/.claude directory`;

const shortId = (id: string): string => id.slice(0, 8);

const shortTime = (ts: string | null | undefined): string =>
  ts ? ts.slice(0, 16).replace("T", " ") : "????-??-?? ??:??";

const projectName = (path: string | null): string =>
  path ? (path.split("/").filter(Boolean).pop() ?? path) : "(unknown)";

const oneLine = (text: string, max = 100): string => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max - 1) + "…" : collapsed;
};

const humanBytes = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const formatted = unit === 0 ? String(value) : value.toFixed(1);
  return `${formatted} ${units[unit]}`;
};

const fail = (message: string): void => {
  console.error(message);
  process.exitCode = 1;
};

const main = (): void => {
  // parseArgs throws on unknown options; turn that into a clean message + exit 1
  // instead of a raw stack trace. The IIFE preserves parseArgs's inferred types.
  const parsed = (() => {
    try {
      return parseArgs({
        args: Bun.argv.slice(2),
        allowPositionals: true,
        options: {
          db: { type: "string" },
          full: { type: "boolean", default: false },
          "dry-run": { type: "boolean", default: false },
          limit: { type: "string" },
          project: { type: "string" },
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
    console.log(HELP);
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
  const db = openDb(dbPath);

  try {
    switch (command) {
      case "index": {
        if (values["dry-run"]) {
          const plan = dryRunIndex(db, values.full);
          if (plan.full) {
            console.log(`Dry run (--full): would re-read all ${plan.filesToRead} file(s).`);
            console.log(`  Candidate messages: ${plan.candidateMessages} (before UUID dedup)`);
            console.log(`  Bytes to read:      ${humanBytes(plan.newBytes)}`);
            console.log(
              "  On an up-to-date archive dedup collapses this to ~0 net-new messages.",
            );
          } else if (plan.filesToRead === 0) {
            console.log(
              `Dry run: nothing to index. ${plan.unchangedFiles}/${plan.filesScanned} files unchanged.`,
            );
          } else {
            console.log("Dry run. Would index:");
            console.log(`  New messages:  ${plan.candidateMessages}`);
            console.log(`  New bytes:     ${humanBytes(plan.newBytes)}`);
            console.log(
              `  Files:         ${plan.newFiles} new, ${plan.grownFiles} grown, ` +
                `${plan.truncatedFiles} truncated, ${plan.unchangedFiles} unchanged (skipped)`,
            );
          }
          console.log("\nNothing written. Run `cerebro index` to apply.");
          break;
        }
        const result = runIndex(db, values.full);
        console.log(
          `Indexed ${result.newMessages} new message(s) ` +
            `(${result.filesIndexed}/${result.filesScanned} files touched).`,
        );
        break;
      }

      case "search": {
        const query = positionals.slice(1).join(" ");
        if (!query) {
          console.error("search: missing <query>");
          process.exitCode = 1;
          break;
        }
        const hits = search(db, query, limit ?? 20);
        if (hits.length === 0) {
          console.log("No matches.");
          break;
        }
        for (const hit of hits) {
          console.log(
            `${shortId(hit.session_id)}  ${shortTime(hit.ts)}  ${hit.role.padEnd(9)}  ${projectName(hit.project_path)}`,
          );
          console.log(`    ${oneLine(hit.snippet, 160)}`);
        }
        console.log(`\n${hits.length} hit(s). Open one with: cerebro show <id>`);
        break;
      }

      case "sessions": {
        const threads = listThreads(db, { project: values.project, limit: limit ?? 30 });
        if (threads.length === 0) {
          console.log("No sessions indexed yet. Run: cerebro index");
          break;
        }
        for (const thread of threads) {
          const resumes =
            thread.sessions_in_thread > 1 ? ` +${thread.sessions_in_thread - 1} resume(s)` : "";
          const deleted = thread.body_available === 0 ? "  [body deleted]" : "";
          console.log(
            `${shortId(thread.id)}  ${shortTime(thread.last_ts)}  ${String(thread.msgs).padStart(4)} msgs  ${projectName(thread.project_path)}${resumes}${deleted}`,
          );
          console.log(`    ${oneLine(thread.title ?? "(untitled)", 120)}`);
        }
        break;
      }

      case "show": {
        const idArg = positionals[1];
        if (!idArg) {
          console.error("show: missing <session-id>");
          process.exitCode = 1;
          break;
        }
        const sessionId = resolveSession(db, idArg);
        if (!sessionId) {
          console.error(`No session matching "${idArg}".`);
          process.exitCode = 1;
          break;
        }
        const messages = threadMessages(db, sessionId);
        console.log(`Thread ${shortId(sessionId)}  ${messages.length} message(s)\n`);

        if (values.full) {
          for (const message of messages) {
            const tag = message.is_sidechain ? " · subagent" : "";
            console.log(`──── ${message.role}${tag} · ${shortTime(message.ts)} ────`);
            console.log(message.text);
            console.log("");
          }
        } else {
          messages.forEach((message, i) => {
            const marker = message.is_sidechain ? "[subagent] " : "";
            console.log(
              `${String(i + 1).padStart(3)}. ${message.role.padEnd(9)} ${shortTime(message.ts)}  ${marker}${oneLine(message.text, 110)}`,
            );
          });
          console.log("\nFull transcript: cerebro show <id> --full");
        }
        break;
      }

      case "stats": {
        const s = stats(db);
        console.log(`Threads:          ${s.threads}`);
        console.log(`Sessions:         ${s.sessions}`);
        console.log(`Messages:         ${s.messages}`);
        console.log(`Deleted sources:  ${s.deletedSources}`);
        break;
      }

      default:
        console.error(`Unknown command: ${command}\n`);
        console.log(HELP);
        process.exitCode = 1;
    }
  } catch (error) {
    // e.g. an ambiguous session prefix or an unexpected SQL error: show the
    // message, not a stack trace.
    fail((error as Error).message);
  } finally {
    db.close();
  }
};

main();
