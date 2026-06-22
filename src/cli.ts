#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { openDb } from "./db.ts";
import { defaultDbPath } from "./paths.ts";
import { runIndex, dryRunIndex } from "./indexer.ts";
import {
  search,
  listThreads,
  recentThreads,
  relevantThreads,
  openingPrompt,
  resolveSession,
  threadMessages,
  stats,
} from "./query.ts";
import {
  DIGEST_PROMPT,
  DIGEST_PROMPT_VERSION,
  buildDigestInput,
  staleThreads,
  writeSummary,
  getSummary,
  searchSummaries,
} from "./digest.ts";
import { gitInfo } from "./git.ts";
import {
  shortId,
  shortTime,
  shortDate,
  projectName,
  oneLine,
  humanBytes,
  recentThreadLine,
  openedLine,
  sessionThreadLine,
} from "./render.ts";

const HELP = `cerebro - permanent verbatim archive + search over Claude Code sessions

Usage:
  cerebro index [--full] [--dry-run]     Index all sessions incrementally
  cerebro search <query> [--limit N]     Full-text search (ranked, snippet-first)
  cerebro sessions [--project P] [--limit N]   List threads, newest first
  cerebro recent [--cwd P] [--days D] [--limit N] [--context]   Recent threads for one repo
  cerebro relevant <prompt> [--limit N] [--context]   Past threads relevant to a prompt
  cerebro show <session-id> [--full]     Show a thread (outline, or full transcript)
  cerebro stats                          Archive counts
  cerebro digest <action>                Curated session summaries (see below)

Digest actions:
  cerebro digest stale [--limit N]            List threads needing a (re)summary
  cerebro digest prompt                       Print the summarization prompt
  cerebro digest input <id>                   Print the size-bounded transcript to summarize
  cerebro digest write <id> [--model M]       Store a summary for a thread (reads it from stdin)
  cerebro digest search <query> [--limit N]   Full-text search the summaries
  cerebro digest show <id>                    Print a thread's stored summary

  cerebro is pure storage and never calls an LLM. A hook or skill produces the
  summary and writes it back, e.g.:
    cerebro digest input <id> | claude -p "$(cerebro digest prompt)" | cerebro digest write <id>

Options:
  --db <path>     Database file (default: $CEREBRO_DB or ~/.claude/cerebro/archive.sqlite)
  --full          index: ignore cursors and re-read everything; show: print full text
  --dry-run       index: report what would be indexed, write nothing
  --limit <n>     Max rows to return
  --project <p>   Filter sessions by project path substring
  --cwd <path>    recent: directory to scope by (default: current dir)
  --days <n>      recent: only threads active within the last n days (default 14)
  --context       recent/relevant: emit an agent-facing context block (for a hook)
  --stdin         relevant: read the prompt from a hook's JSON payload on stdin
  --model <name>  digest write: record which model produced the summary
  -h, --help      Show this help

Env:
  CEREBRO_DB           Override the database path
  CEREBRO_CLAUDE_DIR   Override the ~/.claude directory`;

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
          cwd: { type: "string" },
          days: { type: "string" },
          context: { type: "boolean", default: false },
          stdin: { type: "boolean", default: false },
          model: { type: "string" },
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
          console.log(sessionThreadLine(thread));
          console.log(`    ${oneLine(thread.title ?? "(untitled)", 120)}`);
        }
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
          if (!values.context) console.log("No recent sessions for this repo.");
          break;
        }

        const repoLabel = projectName(repoRoot ?? cwd);

        if (values.context) {
          console.log(
            `Recent Claude Code sessions in this repo (${repoLabel}), from the cerebro archive. ` +
              "Background only; ignore if unrelated to the current task.",
          );
          for (const thread of threads) {
            console.log(recentThreadLine(thread, { showMsgs: false }));
            const opening = openingPrompt(db, thread.id);
            if (opening) console.log(openedLine(opening));
          }
          console.log(
            "\nIf the request overlaps with any of these, recall that work instead of starting over:\n" +
              "  cerebro show <id>          thread outline (add --full for the transcript)\n" +
              '  cerebro search "<terms>"   full-text search across all past sessions',
          );
        } else {
          console.log(`Recent sessions in ${repoLabel} (last ${days} days):`);
          for (const thread of threads) {
            console.log(recentThreadLine(thread, { showMsgs: true }));
            const opening = openingPrompt(db, thread.id);
            if (opening) console.log(openedLine(opening));
          }
          console.log('\nPull prior context: cerebro show <id>  |  cerebro search "<terms>"');
        }
        break;
      }

      case "relevant": {
        // --stdin reads the prompt from a hook's JSON payload (UserPromptSubmit
        // sends { prompt, cwd, ... } on stdin), so the hook needs no jq or wrapper.
        let prompt = positionals.slice(1).join(" ");
        if (values.stdin) {
          try {
            const payload = JSON.parse(readFileSync(0, "utf8")) as { prompt?: unknown };
            prompt = typeof payload.prompt === "string" ? payload.prompt : "";
          } catch {
            prompt = "";
          }
        }
        if (!prompt) {
          if (!values.context) {
            console.error("relevant: missing <prompt>");
            process.exitCode = 1;
          }
          break;
        }
        const threads = relevantThreads(db, prompt, limit ?? 3);
        if (threads.length === 0) {
          // Silent in --context mode so the UserPromptSubmit hook injects nothing.
          if (!values.context) console.log("No related past sessions.");
          break;
        }


        if (values.context) {
          console.log(
            "Possibly relevant past Claude Code sessions (from the cerebro archive, matched " +
              "against this prompt). Background only; ignore any that do not actually relate.",
          );
        } else {
          console.log("Related past sessions:");
        }
        for (const thread of threads) {
          console.log(
            `  ${shortId(thread.id)}  ${shortDate(thread.last_ts)}  ${projectName(thread.project_path)}  ${oneLine(thread.title ?? "(untitled)", 80)}`,
          );
          if (thread.opening) console.log(openedLine(thread.opening));
          if (thread.snippet) {
            // Label which tier the snippet came from: a curated summary outranks
            // a raw-transcript match and is worth flagging as higher-signal.
            const label = thread.fromSummary ? "summary: " : "match:  ";
            console.log(`      ${label}${oneLine(thread.snippet, 120)}`);
          }
        }
        console.log(
          "\nTo recall one: cerebro show <id> (add --full for the transcript), " +
            'or cerebro search "<terms>".',
        );
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

      case "digest": {
        const action = positionals[1];
        switch (action) {
          case "prompt":
            console.log(DIGEST_PROMPT);
            break;

          case "input": {
            const idArg = positionals[2];
            if (!idArg) {
              fail("digest input: missing <session-id>");
              break;
            }
            const sessionId = resolveSession(db, idArg);
            if (!sessionId) {
              fail(`No session matching "${idArg}".`);
              break;
            }
            // The size-bounded transcript fed to `claude -p`. Written raw to stdout
            // (no trailing newline of our own) so it pipes straight into the model.
            process.stdout.write(buildDigestInput(threadMessages(db, sessionId)));
            break;
          }

          case "stale": {
            const rows = staleThreads(db, limit ?? 50);
            if (rows.length === 0) {
              console.log("All threads are summarized and up to date.");
              break;
            }
            for (const row of rows) {
              const reason =
                row.summary_version == null
                  ? "never summarized"
                  : row.summary_version < DIGEST_PROMPT_VERSION
                    ? `prompt v${row.summary_version} < v${DIGEST_PROMPT_VERSION}`
                    : "new activity since summary";
              console.log(
                `${shortId(row.id)}  ${shortTime(row.last_ts)}  ${String(row.msgs).padStart(4)} msgs  ${projectName(row.project_path)}  [${reason}]`,
              );
              console.log(`    ${oneLine(row.title ?? "(untitled)", 100)}`);
            }
            console.log(
              `\n${rows.length} thread(s) need a summary. Summarize one:\n` +
                `  cerebro digest input <id> | claude -p "$(cerebro digest prompt)" | cerebro digest write <id>`,
            );
            break;
          }

          case "write": {
            const idArg = positionals[2];
            if (!idArg) {
              fail("digest write: missing <session-id>");
              break;
            }
            const sessionId = resolveSession(db, idArg);
            if (!sessionId) {
              fail(`No session matching "${idArg}".`);
              break;
            }
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
            const root = writeSummary(db, sessionId, text, values.model ?? null);
            console.log(`Saved summary for thread ${shortId(root)} (${text.length} chars).`);
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
              console.log("No matching summaries.");
              break;
            }
            for (const hit of hits) {
              console.log(
                `${shortId(hit.id)}  ${shortTime(hit.last_ts)}  ${projectName(hit.project_path)}  ${oneLine(hit.title ?? "(untitled)", 70)}`,
              );
              console.log(`    ${oneLine(hit.snippet, 160)}`);
            }
            console.log(
              `\n${hits.length} summary hit(s). Open one: cerebro show <id>  |  full summary: cerebro digest show <id>`,
            );
            break;
          }

          case "show": {
            const idArg = positionals[2];
            if (!idArg) {
              fail("digest show: missing <session-id>");
              break;
            }
            const sessionId = resolveSession(db, idArg);
            if (!sessionId) {
              fail(`No session matching "${idArg}".`);
              break;
            }
            const summary = getSummary(db, sessionId);
            if (!summary) {
              console.log(
                `No summary yet for ${shortId(sessionId)}. Generate the backlog with: cerebro digest stale`,
              );
              break;
            }
            const model = summary.model ? `, ${summary.model}` : "";
            console.log(
              `Summary for thread ${shortId(summary.root_session_id)}  ` +
                `(${shortTime(summary.summarized_at)}${model}, prompt v${summary.prompt_version})\n`,
            );
            console.log(summary.summary);
            break;
          }

          default:
            fail(
              `digest: unknown action "${action ?? ""}". ` +
                "Use: stale | prompt | input <id> | write <id> | search <query> | show <id>",
            );
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
