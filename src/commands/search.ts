import { type SearchHit, search } from "../query.ts";
import { oneLine, projectName, shortId, shortTime } from "../render.ts";
import type { CommandContext } from "./context.ts";

// `search` output: one header + one snippet line per hit, then the count footer. The
// thread title (when there is one) trails the header line, truncated at 60, so a
// hit is recognizable without opening it. The default (deduplicated) mode says so
// in the footer and points at --all; `all` restores the plain per-message footer.
export const searchListing = (hits: SearchHit[], opts: { all?: boolean } = {}): string[] => {
  const lines: string[] = [];
  for (const hit of hits) {
    const title = hit.title ? `  ${oneLine(hit.title, 60)}` : "";
    lines.push(
      `${shortId(hit.session_id)}  ${shortTime(hit.ts)}  ${hit.role.padEnd(9)}  ${projectName(hit.project_path)}${title}`,
    );
    // The ordinal is the message's position in show's numbering, so the hit can be
    // opened in place with show <id> --range.
    lines.push(`    #${hit.ordinal}  ${oneLine(hit.snippet, 160)}`);
  }
  lines.push(
    opts.all
      ? `\n${hits.length} hit(s). Open one with: cerebro show <id> (jump to a hit: --range <n>)`
      : `\n${hits.length} hit(s), best per thread (--all for every message). ` +
          "Open one with: cerebro show <id> (jump to a hit: --range <n>)",
  );
  return lines;
};

// The `search` command: ranked full-text search, best hit per thread by default
// (--all for every matching message), optionally filtered by --project / --since.
export const searchCommand = ({
  db,
  io,
  values,
  positionals,
  limit,
  fail,
  emitJson,
}: CommandContext): void => {
  const query = positionals.slice(1).join(" ");
  if (!query) {
    fail("search: missing <query>");
    return;
  }
  // Anchored shape check plus a round-trip calendar check: an unanchored
  // regex would let "2026-31-01" or trailing garbage through, and Date.parse
  // alone is engine-dependent (JSC rolls "2026-02-30" over to March 2). A
  // bad date would make the lexical ts comparison silently exclude
  // everything instead of erroring.
  if (values.since !== undefined) {
    const parsed = Date.parse(`${values.since}T00:00:00Z`);
    const roundTrips =
      /^\d{4}-\d{2}-\d{2}$/.test(values.since) &&
      !Number.isNaN(parsed) &&
      new Date(parsed).toISOString().slice(0, 10) === values.since;
    if (!roundTrips) {
      fail(`--since must be a valid ISO date like 2026-01-31 (got "${values.since}")`);
      return;
    }
  }
  const hits = search(db, query, limit ?? 20, {
    project: values.project,
    since: values.since,
    all: values.all,
  });
  if (values.json) {
    emitJson(hits);
    return;
  }
  if (hits.length === 0) {
    io.log("No matches.");
    return;
  }
  for (const line of searchListing(hits, { all: values.all })) io.log(line);
};
