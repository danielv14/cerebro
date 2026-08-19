#!/usr/bin/env bun
import type { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import { buildStamp, buildStampLine } from "./build-stamp.ts";
import { flag, type OptionTable, readOptions, text } from "./commands/args.ts";
import { backupCommand } from "./commands/backup.ts";
import {
  type Command,
  type CommandNode,
  type CommandOutput,
  defineCommand,
  isGroup,
} from "./commands/command.ts";
import { digestCommand } from "./commands/digest.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { indexCommand } from "./commands/index-cmd.ts";
import { maintainCommand } from "./commands/maintain.ts";
import { recentCommand } from "./commands/recent.ts";
import { relevantCommand } from "./commands/relevant.ts";
import { searchCommand } from "./commands/search.ts";
import { sessionsCommand } from "./commands/sessions.ts";
import { showCommand } from "./commands/show.ts";
import { skillsCommand } from "./commands/skills.ts";
import { statsCommand } from "./commands/stats.ts";
import { openDb } from "./db.ts";
import { HELP } from "./help.ts";
import { defaultDbPath } from "./paths.ts";

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

// The two options every command accepts. Everything else belongs to exactly one
// command, which is what lets a flag meant for another one be rejected instead of
// silently ignored.
export const GLOBAL_OPTIONS = {
  db: text(),
  help: flag(),
} satisfies OptionTable;

// `version` answers before the database is opened, like --help. That is not just
// speed: doctor's drift check works by spawning the *deployed* binary's `version`,
// and that answer must not depend on whether its archive happens to be readable.
const versionCommand = defineCommand({
  options: { json: flag() } satisfies OptionTable,
  needsDb: false,
  run: ({ dbPath }) => {
    const stamp = buildStamp();
    return { json: { ...stamp, dbPath }, lines: [buildStampLine(stamp), `db: ${dbPath}`] };
  },
});

// The command dispatch table. A Map, not a plain object, so a command name that
// collides with an Object.prototype key (e.g. "toString") can never resolve to an
// inherited function instead of the unknown-command error.
export const commands = new Map<string, CommandNode>([
  ["index", indexCommand],
  ["search", searchCommand],
  ["sessions", sessionsCommand],
  ["recent", recentCommand],
  ["relevant", relevantCommand],
  ["show", showCommand],
  ["digest", digestCommand],
  ["stats", statsCommand],
  ["skills", skillsCommand],
  ["doctor", doctorCommand],
  ["maintain", maintainCommand],
  ["backup", backupCommand],
  ["version", versionCommand],
]);

// Every option any command declares, as the table node:util needs up front. The
// parser has to know the whole vocabulary before it can tell which command was
// asked for; which subset is *allowed* is checked afterwards, per command. A name
// declared by two commands must agree on its kind, which test/cli.test.ts asserts.
const parserOptions = (): Record<string, { type: "string" | "boolean"; short?: string }> => {
  const table: Record<string, { type: "string" | "boolean"; short?: string }> = {
    help: { type: "boolean", short: "h" },
  };
  const add = (options: OptionTable): void => {
    for (const [name, spec] of Object.entries(options)) table[name] ??= { type: spec.kind };
  };
  add(GLOBAL_OPTIONS);
  for (const node of commands.values()) {
    if (isGroup(node)) for (const sub of Object.values(node.subcommands)) add(sub.options);
    else add(node.options);
  }
  return table;
};

const PARSER_OPTIONS = parserOptions();

// Wrapped so the parsed shape is inferred rather than spelled out; parseArgs' own
// type is generic over the option table and unpleasant to write by hand.
const parseCliArgs = (args: string[]) =>
  parseArgs({ args, allowPositionals: true, tokens: true, options: PARSER_OPTIONS });

// The ambient values the dispatcher hands every command (see CommandInput). Both are
// injectable so a test can pin the clock and the working directory; production reads
// them off the process.
export interface CliEnv {
  now?: number;
  cwd?: string;
}

// Parse args, dispatch the command, and report through `io`. `makeDb` is injected
// so tests can supply an in-memory database; production passes openDb. runCli owns
// the database lifetime (open after the help/parse fast-paths, close in finally),
// the option checking, and the rendering. A command handler does none of those:
// it maps validated arguments to a result.
export const runCli = (
  args: string[],
  io: CliIO,
  makeDb: (path: string) => Database = openDb,
  env: CliEnv = {},
): void => {
  const fail = (message: string): void => {
    io.error(message);
    io.setExitCode(1);
  };

  // parseArgs throws on an option no command knows at all; turn that into a clean
  // message + exit 1 instead of a raw stack trace. `tokens` records which options
  // were actually supplied, which the values object cannot express.
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(args);
  } catch (error) {
    fail((error as Error).message);
    return;
  }
  const { values, positionals, tokens } = parsed;

  if (values.help || positionals.length === 0) {
    io.log(HELP);
    return;
  }

  const name = positionals[0]!;
  const node = commands.get(name);
  if (!node) {
    io.error(`Unknown command: ${name}\n`);
    io.log(HELP);
    io.setExitCode(1);
    return;
  }

  // A group (digest) resolves one more positional to the action that owns the
  // options and the run step; a plain command is its own.
  let command: Command;
  let rest: string[];
  let label: string;
  if (isGroup(node)) {
    const action = positionals[1];
    const sub = action ? node.subcommands[action] : undefined;
    if (!sub) {
      fail(node.unknownAction(action));
      return;
    }
    command = sub;
    rest = positionals.slice(2);
    label = `${name} ${action}`;
  } else {
    command = node;
    rest = positionals.slice(1);
    label = name;
  }

  // The check that used to be missing: a flag this command did not declare is an
  // error, not something to swallow. Without it `cerebro sessions --keep 3` parsed
  // fine and ignored --keep.
  const accepted = new Set([
    ...Object.keys(GLOBAL_OPTIONS),
    "help",
    ...Object.keys(command.options),
  ]);
  for (const token of tokens) {
    if (token.kind === "option" && !accepted.has(token.name)) {
      fail(`Unknown option --${token.name} for \`cerebro ${label}\`. See cerebro --help.`);
      return;
    }
  }

  // Coerce and validate this command's own options, once, here.
  let commandArgs: Record<string, unknown>;
  try {
    commandArgs = readOptions(command.options, values);
  } catch (error) {
    fail((error as Error).message);
    return;
  }

  const dbPath = (typeof values.db === "string" && values.db) || defaultDbPath();
  // Read once per run, so every command in one dispatch sees the same instant.
  const now = env.now ?? Date.now();
  const cwd = env.cwd ?? process.cwd();

  // Emit whatever the command produced: raw stdout, or JSON when the command
  // declares --json and it was asked for, or the rendered lines, or the empty
  // state. A --context hook contract asks for silence instead of an empty state.
  const emit = (output: CommandOutput): void => {
    if (output.raw !== undefined) io.write(output.raw);
    else if (values.json === true && "json" in output) io.log(JSON.stringify(output.json, null, 2));
    else if (output.lines && output.lines.length > 0) for (const line of output.lines) io.log(line);
    else if (!output.silentWhenEmpty && output.empty !== undefined) io.log(output.empty);
    if (output.exitCode) io.setExitCode(output.exitCode);
  };

  if (command.needsDb === false) {
    // No database to open, close, or fail on.
    emit(
      command.run({
        db: null as unknown as Database,
        args: commandArgs,
        rest,
        dbPath,
        now,
        cwd,
        progress: io.log,
      }),
    );
    return;
  }

  // Opening can fail (permissions, corrupt file, a lost migration race): report it
  // like any other error instead of escaping runCli as an unhandled stack trace.
  let db: Database;
  try {
    db = makeDb(dbPath);
  } catch (error) {
    fail(`could not open database at ${dbPath}: ${(error as Error).message}`);
    return;
  }

  try {
    emit(command.run({ db, args: commandArgs, rest, dbPath, now, cwd, progress: io.log }));
  } catch (error) {
    // A CliError (a bad argument, an unresolvable id), an ambiguous session prefix,
    // or an unexpected SQL error: show the message, not a stack trace.
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
