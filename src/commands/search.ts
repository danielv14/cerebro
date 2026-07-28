import { SEARCH_ROLES, type SearchHit, search } from "../query.ts";
import { oneLine, projectName, shortId, shortTime } from "../render.ts";
import { CliError, choice, flag, isoDate, numeric, type OptionTable, text } from "./args.ts";
import { defineCommand } from "./command.ts";

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

const options = {
  project: text(),
  since: isoDate(),
  role: choice(SEARCH_ROLES),
  prose: flag(),
  all: flag(),
  limit: numeric({ integer: true, min: 1, label: "a positive integer" }),
  json: flag(),
} satisfies OptionTable;

// The `search` command: ranked full-text search, best hit per thread by default
// (--all for every matching message), optionally filtered by --project / --since /
// --role / --prose.
export const searchCommand = defineCommand({
  options,
  run: ({ db, args, rest }) => {
    const query = rest.join(" ");
    if (!query) throw new CliError("search: missing <query>");
    const hits = search(db, query, args.limit ?? 20, {
      project: args.project,
      since: args.since,
      role: args.role,
      prose: args.prose,
      all: args.all,
    });
    return {
      json: hits,
      lines: hits.length > 0 ? searchListing(hits, { all: args.all }) : [],
      empty: "No matches.",
    };
  },
});
