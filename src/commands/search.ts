import { search } from "../query.ts";
import { searchListing } from "../render.ts";
import type { CommandContext } from "./context.ts";

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
