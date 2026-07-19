import { statSync } from "node:fs";
import { countStaleThreads } from "../digest/index.ts";
import { type Stats, stats } from "../query.ts";
import { humanBytes, projectName, shortDate } from "../render.ts";
import type { CommandContext } from "./context.ts";

// `stats` output: the archive counts, labels left-aligned to a shared column.
// `extras` carries what the query layer cannot know: the database file size
// (measured on the path by the command; null for :memory: or a missing file) and
// the stale-thread count (owned by the digest layer, since it depends on the
// prompt version).
export const statsReport = (
  s: Stats,
  extras: { dbBytes: number | null; staleThreads: number } = { dbBytes: null, staleThreads: 0 },
): string[] => {
  const lines = [
    `Threads:          ${s.threads} (${s.summarizedThreads} summarized, ${extras.staleThreads} stale)`,
    `Sessions:         ${s.sessions}`,
    `Messages:         ${s.messages}`,
    `Deleted sources:  ${s.deletedSources}`,
    `Span:             ${shortDate(s.firstTs)} .. ${shortDate(s.lastTs)}`,
  ];
  if (extras.dbBytes !== null) lines.push(`Database size:    ${humanBytes(extras.dbBytes)}`);
  if (s.topProjects.length > 0) {
    lines.push(
      `Top projects:     ${s.topProjects
        .map((p) => `${projectName(p.project_path)} (${p.threads})`)
        .join(", ")}`,
    );
  }
  return lines;
};

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
