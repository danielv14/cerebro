import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolveSession } from "../query.ts";
import { CliError } from "./args.ts";

// The two things command modules share that are neither option handling (args.ts)
// nor the command shape itself (command.ts).

// Read all of stdin, degrading to "" when there is no stdin (a closed or absent
// fd 0 throws from readFileSync). The stdin-consuming commands (relevant --stdin,
// digest run --stdin, digest write) share this so the degrade-never-throw
// contract is written once.
export const readStdin = (): string => {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
};

// Resolve a positional session-id argument (an id or a unique prefix) to a full
// session id. Throws the right CliError when it is missing or matches nothing, so
// every id-taking command reports it identically. An ambiguous prefix throws from
// resolveSession itself.
export const resolveOrThrow = (db: Database, idArg: string | undefined, label: string): string => {
  if (!idArg) throw new CliError(`${label}: missing <session-id>`);
  const sessionId = resolveSession(db, idArg);
  if (!sessionId) throw new CliError(`No session matching "${idArg}".`);
  return sessionId;
};
