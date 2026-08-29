import type { Database } from "bun:sqlite";
import type { OptionTable, OptionValues } from "./args.ts";

// The command shape: a declared option table plus a run step from validated
// arguments to a result. See CLAUDE.md ("How a command is shaped").

// Everything the dispatcher supplies that is not the database. A command that
// answers before the archive is opened is typed against this alone, so there is no
// slot to fill with a database that does not exist.
export interface CommandContext<A> {
  args: A;
  // Supplied by the dispatcher so window arithmetic is a function of the input and
  // a test can pin an instant. A command with its own --cwd flag lets the flag win
  // (`recent`); `relevant` deliberately does not fall back to `cwd` at all.
  now: number;
  cwd: string;
  // Positionals after the command name (and after the sub-action for a group).
  rest: string[];
  // Where the archive is, reportable without reading it (`version`).
  dbPath: string;
  // Emit a line *now*, before the command returns. Not a second output channel:
  // it exists because `digest drain` makes up to N model calls over minutes, and
  // buffering the lines would make a hung call indistinguishable from a slow one.
  progress: (line: string) => void;
}

export interface CommandInput<A> extends CommandContext<A> {
  db: Database;
}

export interface CommandOutput {
  // The payload for --json. The key's presence is what the dispatcher checks, so a
  // deliberate `null` (no stored summary) is emitted rather than treated as missing.
  json?: unknown;
  // The human rendering, one string per line.
  lines?: string[];
  // Raw stdout with no trailing newline, for output that is piped (digest input).
  raw?: string;
  // Printed instead of `lines` when there is nothing to show.
  empty?: string;
  // The contract with the hooks that inject --context blocks: silence means
  // "inject nothing", and an empty-state line would end up in the model.
  silentWhenEmpty?: boolean;
  // Non-zero marks a reported problem; the output is still printed.
  exitCode?: number;
}

// `needsDb` is the discriminant that tells the dispatcher which call it is making.
// Both arms are built through the builders below, the one place the argument type
// is cast away; the dispatcher itself casts nothing.
export type Command = { options: OptionTable } & (
  | { needsDb: true; run: (input: CommandInput<Record<string, unknown>>) => CommandOutput }
  | { needsDb: false; run: (context: CommandContext<Record<string, unknown>>) => CommandOutput }
);

// A command that dispatches over sub-actions (digest). Each action declares its
// own options, so a foreign flag is rejected the same way as on a top-level
// command.
export interface CommandGroup {
  subcommands: Record<string, Command>;
  unknownAction: (action: string | undefined) => string;
}

export type CommandNode = Command | CommandGroup;

export const isGroup = (node: CommandNode): node is CommandGroup => "subcommands" in node;

// Every command in a registry, paired with the label the CLI calls it by. One walk
// over the two-level shape, so the option table built from the registry and the
// tests that pin it cannot disagree about what is in it.
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
// error rather than a crash on a null. The flag comes from the builder, so the run
// step's type and the dispatcher's behaviour cannot disagree.
export const defineDbLessCommand = <T extends OptionTable>(spec: {
  options: T;
  run: (context: CommandContext<OptionValues<T>>) => CommandOutput;
}): Command => ({
  options: spec.options,
  needsDb: false,
  run: (context) => spec.run(context as unknown as CommandContext<OptionValues<T>>),
});
