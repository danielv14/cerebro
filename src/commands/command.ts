import type { Database } from "bun:sqlite";
import type { OptionTable, OptionValues } from "./args.ts";

// What a command is: a declared set of options, and a run step from validated
// arguments to a result. A command does not print, does not decide between JSON and
// a listing, and cannot reach a flag it did not declare. The dispatcher owns all
// three, and it owns the database too: a command that declares it needs no archive
// has no way to reach one.

// Everything the dispatcher supplies that is not the database. A command that
// answers before the archive is opened is typed against this alone, so there is no
// slot to fill with a database that does not exist.
export interface CommandContext<A> {
  // The command's own validated options.
  args: A;
  // The instant the command runs at, and the directory it was invoked in, both
  // supplied by the dispatcher. A command reads the clock and the cwd from here
  // rather than from the process, so its window arithmetic is a function of its input
  // and a test can pin an instant instead of widening a window until the real clock
  // cannot affect the assertion. A command with its own --cwd flag still lets the flag
  // win (`recent`), and `relevant` deliberately does not fall back to `cwd` at all:
  // without a flag or a hook payload it ranks globally.
  now: number;
  cwd: string;
  // Positionals after the command name (and after the sub-action for a group), so
  // a command never indexes past its own arguments.
  rest: string[];
  // Where the archive is, which a command can report without reading it (`version`).
  dbPath: string;
  // Emit a line *now*, before the command returns. This is not a second output
  // channel for results: it exists because `digest drain` makes up to N model
  // calls over several minutes and its only witness is a log file someone tails.
  // Buffering those lines until the end would make a hung call indistinguishable
  // from a slow one. Everything else returns its lines and ignores this.
  progress: (line: string) => void;
}

export interface CommandInput<A> extends CommandContext<A> {
  db: Database;
}

export interface CommandOutput {
  // The payload for --json. A command that declares `json` must supply this; the
  // key's presence is what the dispatcher checks, so a deliberate `null` (no
  // stored summary) is emitted rather than treated as missing.
  json?: unknown;
  // The human rendering, one string per line.
  lines?: string[];
  // Raw stdout with no trailing newline, for output that is piped rather than
  // read (digest input).
  raw?: string;
  // Printed instead of `lines` when there is nothing to show.
  empty?: string;
  // Print nothing at all when there is nothing to show. This is the contract with
  // the hooks that inject `recent --context` and `relevant --context`: silence
  // means "inject nothing", and an empty-state line would end up in the model.
  silentWhenEmpty?: boolean;
  // Non-zero marks a reported problem (doctor's hard failure, a digest run that
  // stored nothing). The output is still printed; this only sets the exit code.
  exitCode?: number;
}

// The erased shape the dispatcher works with: a command either reads an open
// archive or answers from the context alone, and `needsDb` is the discriminant that
// tells the dispatcher which call it is making. Both arms are built through the
// builders below, which is where the argument type is tied back to the option table
// and where `needsDb` is set; those are the one place either connection is cast
// away, and the dispatcher itself casts nothing.
export type Command = { options: OptionTable } & (
  | { needsDb: true; run: (input: CommandInput<Record<string, unknown>>) => CommandOutput }
  | { needsDb: false; run: (context: CommandContext<Record<string, unknown>>) => CommandOutput }
);

// A command that dispatches over sub-actions (digest). Each action declares its
// own options, so `digest search --bytes 5` is rejected the same way an unknown
// flag on a top-level command is.
export interface CommandGroup {
  subcommands: Record<string, Command>;
  // The error for a missing or unknown action, which names the valid ones.
  unknownAction: (action: string | undefined) => string;
}

export type CommandNode = Command | CommandGroup;

export const isGroup = (node: CommandNode): node is CommandGroup => "subcommands" in node;

// Build a command, tying its run step's arguments to its option table. The cast is
// the single point where that link is erased for the dispatcher; every caller of
// defineCommand keeps full inference.
export const defineCommand = <T extends OptionTable>(spec: {
  options: T;
  run: (input: CommandInput<OptionValues<T>>) => CommandOutput;
}): Command => ({
  options: spec.options,
  needsDb: true,
  run: (input) => spec.run(input as unknown as CommandInput<OptionValues<T>>),
});

// Build a command that answers before the archive is opened. Its run step takes the
// context alone, so reaching for a database is a compile error rather than a crash
// on a null. The flag comes from the builder rather than the caller, so the run
// step's type and the dispatcher's behaviour cannot disagree.
export const defineDbLessCommand = <T extends OptionTable>(spec: {
  options: T;
  run: (context: CommandContext<OptionValues<T>>) => CommandOutput;
}): Command => ({
  options: spec.options,
  needsDb: false,
  run: (context) => spec.run(context as unknown as CommandContext<OptionValues<T>>),
});
