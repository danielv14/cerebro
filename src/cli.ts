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

// Design notes: docs/architecture.md ("CLI").

export interface CliIO {
  log: (line: string) => void;
  error: (line: string) => void;
  write: (text: string) => void; // raw stdout, no trailing newline
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

const GLOBAL_OPTIONS = {
  db: text(),
  help: flag(),
} satisfies OptionTable;

// db-less on purpose: doctor's drift check spawns the deployed binary's
// `version`, and that answer must not depend on the archive being readable.
const versionCommand = defineDbLessCommand({
  options: { json: flag() } satisfies OptionTable,
  run: ({ dbPath }) => {
    const stamp = buildStamp();
    return { json: { ...stamp, dbPath }, lines: [buildStampLine(stamp), `db: ${dbPath}`] };
  },
});

// A Map, not a plain object, so a command name colliding with an
// Object.prototype key can never resolve to an inherited function.
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

// One table for the whole vocabulary, so a name declared with two different
// kinds is caught here at startup instead of silently breaking the loser.
export const buildParserOptions = (
  entries: Iterable<[string, CommandNode]>,
): Record<string, { type: "string" | "boolean"; short?: string }> => {
  // `help` is seeded rather than declared: only this table can carry the -h alias.
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

const parseCliArgs = (args: string[]) =>
  parseArgs({ args, allowPositionals: true, tokens: true, options: PARSER_OPTIONS });

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

  // `tokens` records which options were actually supplied, which the values
  // object cannot express.
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
    fail((error as Error).message);
  } finally {
    db.close();
  }
};

const main = (): void => {
  runCli(Bun.argv.slice(2), realIO);
};

// Importing this module (a test driving runCli) must not execute a command.
if (import.meta.main) main();
