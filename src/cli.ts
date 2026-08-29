#!/usr/bin/env bun
import type { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import { buildStamp, buildStampLine } from "./build-stamp.ts";
import { flag, type OptionTable, readOptions, text } from "./commands/args.ts";
import { backupCommand } from "./commands/backup.ts";
import {
  type Command,
  type CommandContext,
  type CommandNode,
  type CommandOutput,
  defineDbLessCommand,
  eachCommand,
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

// The dispatcher: parsing, option checking, db lifetime, rendering. Design notes:
// docs/architecture.md ("CLI").

// Routing every line through this is what makes runCli testable: a test passes a
// capturing sink instead of spawning the binary.
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

// The two options every command accepts; everything else belongs to exactly one
// command.
const GLOBAL_OPTIONS = {
  db: text(),
  help: flag(),
} satisfies OptionTable;

// db-less on purpose: doctor's drift check spawns the *deployed* binary's
// `version`, and that answer must not depend on whether its archive is readable.
const versionCommand = defineDbLessCommand({
  options: { json: flag() } satisfies OptionTable,
  run: ({ dbPath }) => {
    const stamp = buildStamp();
    return { json: { ...stamp, dbPath }, lines: [buildStampLine(stamp), `db: ${dbPath}`] };
  },
});

// A Map, not a plain object, so a command name that collides with an
// Object.prototype key (e.g. "toString") can never resolve to an inherited
// function.
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

// parseArgs needs the whole vocabulary before the command is known, so a name can
// only be parsed one way. Two commands declaring the same name with different
// kinds would silently break the loser for every user (a --limit redeclared as
// boolean coerces "true" and errors; a --db redeclared as flag reads back absent),
// so the collision throws here, where the table is built. Taking the entries as a
// parameter lets a test hand this a clashing pair.
export const buildParserOptions = (
  entries: Iterable<[string, CommandNode]>,
): Record<string, { type: "string" | "boolean"; short?: string }> => {
  // `help` is seeded rather than declared, because only this table can carry the
  // `-h` short alias.
  const table: Record<string, { type: "string" | "boolean"; short?: string }> = {
    help: { type: "boolean", short: "h" },
  };
  const owners = new Map<string, string>([["help", "the parser's own -h alias"]]);
  const add = (owner: string, options: OptionTable): void => {
    for (const [name, spec] of Object.entries(options)) {
      const declared = table[name];
      if (declared) {
        if (declared.type !== spec.kind) {
          throw new Error(
            `Option --${name} is declared as ${declared.type} by ${owners.get(name)} and as ` +
              `${spec.kind} by ${owner}. The parser needs one kind per option name.`,
          );
        }
        continue;
      }
      table[name] = { type: spec.kind };
      owners.set(name, owner);
    }
  };
  add("the global options", GLOBAL_OPTIONS);
  for (const [label, command] of eachCommand(entries)) {
    add(`\`cerebro ${label}\``, command.options);
  }
  return table;
};

const PARSER_OPTIONS = buildParserOptions(commands);

// Wrapped so the parsed shape is inferred; parseArgs' own type is generic over the
// option table and unpleasant to write by hand.
const parseCliArgs = (args: string[]) =>
  parseArgs({ args, allowPositionals: true, tokens: true, options: PARSER_OPTIONS });

// Injectable so a test can pin the clock and the working directory.
export interface CliEnv {
  now?: number;
  cwd?: string;
}

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
  // message + exit 1. `tokens` records which options were actually supplied, which
  // the values object cannot express.
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
  // options and the run step.
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

  // A flag this command did not declare is an error, not something to swallow
  // (`cerebro sessions --keep 3` used to parse fine and ignore --keep).
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
  const context: CommandContext<Record<string, unknown>> = {
    args: commandArgs,
    rest,
    dbPath,
    now,
    cwd,
    progress: io.log,
  };

  const emit = (output: CommandOutput): void => {
    if (output.raw !== undefined) io.write(output.raw);
    else if (values.json === true && "json" in output) io.log(JSON.stringify(output.json, null, 2));
    else if (output.lines && output.lines.length > 0) for (const line of output.lines) io.log(line);
    else if (!output.silentWhenEmpty && output.empty !== undefined) io.log(output.empty);
    if (output.exitCode) io.setExitCode(output.exitCode);
  };

  if (!command.needsDb) {
    emit(command.run(context));
    return;
  }

  // Opening can fail (permissions, corrupt file, a lost migration race): report it
  // like any other error instead of an unhandled stack trace.
  let db: Database;
  try {
    db = makeDb(dbPath);
  } catch (error) {
    fail(`could not open database at ${dbPath}: ${(error as Error).message}`);
    return;
  }

  try {
    emit(command.run({ ...context, db }));
  } catch (error) {
    // A CliError, an ambiguous session prefix, or an unexpected SQL error: show
    // the message, not a stack trace.
    fail((error as Error).message);
  } finally {
    db.close();
  }
};

const main = (): void => {
  runCli(Bun.argv.slice(2), realIO);
};

// Importing this module (e.g. from a test that drives runCli directly) must not
// execute a command.
if (import.meta.main) main();
