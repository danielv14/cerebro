import type { Database } from "bun:sqlite";
import { resolveSession } from "../query.ts";

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

// The parsed option values runCli hands to a command handler: the explicit shape
// of what parseArgs infers from the option table in cli.ts. The assignment in
// runCli is what keeps the two in sync (typecheck fails if the option table and
// this interface drift apart).
export interface CliValues {
  db?: string;
  full: boolean;
  rebuild: boolean;
  "dry-run": boolean;
  limit?: string;
  project?: string;
  cwd?: string;
  days?: string;
  since?: string;
  all: boolean;
  context: boolean;
  stdin: boolean;
  ids: boolean;
  model?: string;
  bytes?: string;
  range?: string;
  to?: string;
  keep?: string;
  json: boolean;
  help: boolean;
}

// Everything a command handler needs from runCli: the open database, the output
// sink, the parsed flags/positionals, and the shared reporting helpers. Command
// modules import from here, never from cli.ts (that would be an import cycle);
// this module is the seam between the dispatcher and the handlers.
export interface CommandContext {
  db: Database;
  io: CliIO;
  values: CliValues;
  positionals: string[];
  dbPath: string;
  limit: number | undefined;
  fail: (message: string) => void;
  emitJson: (payload: unknown) => void;
}

// Resolve a positional session-id argument (an id or a unique prefix) to a full
// session id, reporting the right error and setting exit 1 when it is missing or
// matches nothing. Returns null in those cases so the caller can stop. The five
// id-taking commands (show, digest input/model/write/show) share this instead of
// each re-checking the argument. An ambiguous prefix still throws from
// resolveSession and is caught by runCli's outer handler, as before.
export const resolveOrFail = (
  db: Database,
  idArg: string | undefined,
  label: string,
  fail: (message: string) => void,
): string | null => {
  if (!idArg) {
    fail(`${label}: missing <session-id>`);
    return null;
  }
  const sessionId = resolveSession(db, idArg);
  if (!sessionId) {
    fail(`No session matching "${idArg}".`);
    return null;
  }
  return sessionId;
};
