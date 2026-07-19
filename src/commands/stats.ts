import { statSync } from "node:fs";
import { countStaleThreads } from "../digest.ts";
import { stats } from "../query.ts";
import { statsReport } from "../render.ts";
import type { CommandContext } from "./context.ts";

// The `stats` command: archive counts plus the database file size and the digest
// staleness count.
export const statsCommand = ({ db, io, values, dbPath, emitJson }: CommandContext): void => {
  // The file size lives outside the query layer (and is meaningless for the
  // in-memory databases tests use); the stale count is the digest layer's,
  // since staleness depends on DIGEST_PROMPT_VERSION.
  let dbBytes: number | null = null;
  try {
    dbBytes = statSync(dbPath).size;
  } catch {
    dbBytes = null;
  }
  const stale = countStaleThreads(db);
  if (values.json) {
    emitJson({ ...stats(db), dbBytes, staleThreads: stale });
    return;
  }
  for (const line of statsReport(stats(db), { dbBytes, staleThreads: stale })) {
    io.log(line);
  }
};
