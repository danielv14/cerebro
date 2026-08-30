import type { Database } from "bun:sqlite";
import type { GitResolver } from "../git.ts";
import type { OptionTable, OptionValues } from "./args.ts";

// See CLAUDE.md ("How a command is shaped").

export interface CommandContext<A> {
  args: A;
  now: number;
  cwd: string;
  resolveGit: GitResolver;
  rest: string[];
  dbPath: string;
  // Emits NOW, before the command returns: digest drain makes model calls over
  // minutes, and buffering would make a hung call look like a slow one.
  progress: (line: string) => void;
}

export interface CommandInput<A> extends CommandContext<A> {
  db: Database;
}

export interface CommandOutput {
  // Presence of the key is what the dispatcher checks, so a deliberate `null`
  // is emitted rather than treated as missing.
  json?: unknown;
  lines?: string[];
  // Raw stdout, no trailing newline.
  raw?: string;
  empty?: string;
  // The contract with context-injecting hooks: silence means "inject nothing";
  // an empty-state line would end up in the model.
  silentWhenEmpty?: boolean;
  exitCode?: number;
}

// The builders below are the one place the argument type is cast away; the
// dispatcher itself casts nothing.
export type Command = { options: OptionTable } & (
  | { needsDb: true; run: (input: CommandInput<Record<string, unknown>>) => CommandOutput }
  | { needsDb: false; run: (context: CommandContext<Record<string, unknown>>) => CommandOutput }
);

export interface CommandGroup {
  subcommands: Record<string, Command>;
  unknownAction: (action: string | undefined) => string;
}

export type CommandNode = Command | CommandGroup;

export const isGroup = (node: CommandNode): node is CommandGroup => "subcommands" in node;

export const eachCommand = (entries: Iterable<[string, CommandNode]>): [string, Command][] =>
  [...entries].flatMap(([name, node]) =>
    isGroup(node)
      ? Object.entries(node.subcommands).map(([action, sub]): [string, Command] => [
          `${name} ${action}`,
          sub,
        ])
      : [[name, node] as [string, Command]],
  );

export const defineCommand = <T extends OptionTable>(spec: {
  options: T;
  run: (input: CommandInput<OptionValues<T>>) => CommandOutput;
}): Command => ({
  options: spec.options,
  needsDb: true,
  run: (input) => spec.run(input as unknown as CommandInput<OptionValues<T>>),
});

// The run step takes the context alone, so reaching for a database is a compile
// error rather than a crash on a null.
export const defineDbLessCommand = <T extends OptionTable>(spec: {
  options: T;
  run: (context: CommandContext<OptionValues<T>>) => CommandOutput;
}): Command => ({
  options: spec.options,
  needsDb: false,
  run: (context) => spec.run(context as unknown as CommandContext<OptionValues<T>>),
});
