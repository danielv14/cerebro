#!/usr/bin/env bun
import type { Database } from "bun:sqlite";
import { backupCommand } from "./commands/backup.ts";
import { type CliIO, type CommandContext, parseCliArgs } from "./commands/context.ts";
import { digestCommand } from "./commands/digest.ts";
import { indexCommand } from "./commands/index-cmd.ts";
import { maintainCommand } from "./commands/maintain.ts";
import { recentCommand } from "./commands/recent.ts";
import { relevantCommand } from "./commands/relevant.ts";
import { searchCommand } from "./commands/search.ts";
import { sessionsCommand } from "./commands/sessions.ts";
import { showCommand } from "./commands/show.ts";
import { statsCommand } from "./commands/stats.ts";
import { openDb } from "./db.ts";
import { HELP } from "./help.ts";
import { defaultDbPath } from "./paths.ts";

export type { CliIO } from "./commands/context.ts";

const realIO: CliIO = {
  log: (line) => process.stdout.write(`${line}\n`),
  error: (line) => process.stderr.write(`${line}\n`),
  write: (text) => process.stdout.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

// The command dispatch table. A Map, not a plain object, so a command name that
// collides with an Object.prototype key (e.g. "toString") can never resolve to an
// inherited function instead of the unknown-command error.
const commands = new Map<string, (ctx: CommandContext) => void>([
  ["index", indexCommand],
  ["search", searchCommand],
  ["sessions", sessionsCommand],
  ["recent", recentCommand],
  ["relevant", relevantCommand],
  ["show", showCommand],
  ["digest", digestCommand],
  ["stats", statsCommand],
  ["maintain", maintainCommand],
  ["backup", backupCommand],
]);

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

  // parseCliArgs (commands/context.ts, the owner of the option table) throws on
  // unknown options; turn that into a clean message + exit 1 instead of a raw
  // stack trace.
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(args);
  } catch (error) {
    fail((error as Error).message);
    return;
  }
  const { values, positionals } = parsed;

  const command = positionals[0];

  if (values.help || !command) {
    io.log(HELP);
    return;
  }

  // --limit is shared by most commands, so it is validated once here and handed to
  // the handlers pre-parsed through the context.
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

  // The context handed to the command handlers under src/commands/: everything a
  // handler needs, so handlers never import from cli.ts.
  const ctx: CommandContext = { db, io, values, positionals, dbPath, limit, fail, emitJson };

  try {
    const handler = commands.get(command);
    if (handler) {
      handler(ctx);
    } else {
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
