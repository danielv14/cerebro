import { oneLine, projectName, shortId, shortTime } from "../render.ts";
import { SEARCH_ROLES, type SearchHit, search } from "../search.ts";
import { CliError, choice, flag, isoDate, type OptionTable, positiveInt, text } from "./args.ts";
import { defineCommand } from "./command.ts";

export const searchListing = (hits: SearchHit[], opts: { all?: boolean } = {}): string[] => {
  const lines: string[] = [];
  for (const hit of hits) {
    const title = hit.title ? `  ${oneLine(hit.title, 60)}` : "";
    lines.push(
      `${shortId(hit.session_id)}  ${shortTime(hit.ts)}  ${hit.role.padEnd(9)}  ${projectName(hit.project_path)}${title}`,
    );
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
  branch: text(),
  since: isoDate(),
  role: choice(SEARCH_ROLES),
  prose: flag(),
  all: flag(),
  limit: positiveInt(),
  json: flag(),
} satisfies OptionTable;

export const searchCommand = defineCommand({
  options,
  run: ({ db, args, rest }) => {
    const query = rest.join(" ");
    if (!query) throw new CliError("search: missing <query>");
    const hits = search(db, query, args.limit ?? 20, {
      project: args.project,
      branch: args.branch,
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
