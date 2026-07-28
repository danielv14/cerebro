import type { Database } from "bun:sqlite";
import type { OptionTable, OptionValues } from "./args.ts";

// What a command is: a declared set of options, and a run step from the database
// plus validated arguments to a result. A command does not print, does not decide
// between JSON and a listing, and cannot reach a flag it did not declare. The
// dispatcher owns all three.

export interface CommandInput<A> {
  db: Database;
  // The command's own validated options.
  args: A;
  // Positionals after the command name (and after the sub-action for a group), so
  // a command never indexes past its own arguments.
  rest: string[];
  dbPath: string;
  // Emit a line *now*, before the command returns. This is not a second output
  // channel for results: it exists because `digest drain` makes up to N model
  // calls over several minutes and its only witness is a log file someone tails.
  // Buffering those lines until the end would make a hung call indistinguishable
  // from a slow one. Everything else returns its lines and ignores this.
  progress: (line: string) => void;
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

// The erased shape the dispatcher works with. Commands are built through
// defineCommand, which is where the argument type is tied back to the option
// table; this is the one place the connection is cast away.
export interface Command {
  options: OptionTable;
  run: (input: CommandInput<Record<string, unknown>>) => CommandOutput;
  // `version` answers before the database is opened: doctor's drift check spawns
  // the deployed binary's `version`, and that answer must not depend on whether
  // its archive happens to be readable.
  needsDb?: boolean;
}

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
  needsDb?: boolean;
}): Command => ({
  options: spec.options,
  needsDb: spec.needsDb,
  run: (input) => spec.run(input as unknown as CommandInput<OptionValues<T>>),
});
