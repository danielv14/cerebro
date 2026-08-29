import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { escapeLike } from "../fts.ts";
import { CliError } from "./args.ts";

// Degrades to "" when there is no stdin (a closed fd 0 throws from readFileSync).
export const readStdin = (): string => {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
};

// Throws on an ambiguous prefix, returns null when nothing matches.
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

export const resolveOrThrow = (db: Database, idArg: string | undefined, label: string): string => {
  if (!idArg) throw new CliError(`${label}: missing <session-id>`);
  const sessionId = resolveSession(db, idArg);
  if (!sessionId) throw new CliError(`No session matching "${idArg}".`);
  return sessionId;
};
