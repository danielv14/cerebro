import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { escapeLike } from "../like.ts";
import { CliError } from "./args.ts";

// Degrades to "" when there is no stdin (a closed fd 0 throws from readFileSync).
export const readStdin = (): string => {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
};

const AMBIGUOUS_LISTED = 10;

export const resolveSession = (db: Database, idOrPrefix: string): string | null => {
  const exact = db
    .query("SELECT session_id FROM sessions WHERE session_id = ?")
    .get(idOrPrefix) as { session_id: string } | null;
  if (exact) return exact.session_id;

  const matches = db
    .query("SELECT session_id FROM sessions WHERE session_id LIKE ? || '%' ESCAPE '\\' LIMIT ?")
    .all(escapeLike(idOrPrefix), AMBIGUOUS_LISTED + 1) as { session_id: string }[];

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const listed = matches.slice(0, AMBIGUOUS_LISTED);
    const count = matches.length > AMBIGUOUS_LISTED ? `${AMBIGUOUS_LISTED}+` : `${matches.length}`;
    throw new Error(
      `Ambiguous session prefix "${idOrPrefix}" matches ${count}: ` +
        listed.map((m) => m.session_id.slice(0, 12)).join(", "),
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
