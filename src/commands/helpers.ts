import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { escapeLike } from "../fts.ts";
import { CliError } from "./args.ts";

// What command modules share that is neither option handling (args.ts) nor the
// command shape itself (command.ts).

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

// Resolve an exact id or a unique prefix to a full session id. Throws on an
// ambiguous prefix, returns null when nothing matches. Lives next to its one
// consumer (resolveOrThrow below): prefix resolution is how the CLI reads an id
// argument, not a general query concern.
export const resolveSession = (db: Database, idOrPrefix: string): string | null => {
  const exact = db
    .query("SELECT session_id FROM sessions WHERE session_id = ?")
    .get(idOrPrefix) as { session_id: string } | null;
  if (exact) return exact.session_id;

  const matches = db
    .query("SELECT session_id FROM sessions WHERE session_id LIKE ? || '%' ESCAPE '\\' LIMIT 10")
    .all(escapeLike(idOrPrefix)) as { session_id: string }[];

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous session prefix "${idOrPrefix}" matches ${matches.length}: ` +
        matches.map((m) => m.session_id.slice(0, 12)).join(", "),
    );
  }
  return matches[0]!.session_id;
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
