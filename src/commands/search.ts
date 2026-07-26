import { SEARCH_ROLES, type SearchHit, search } from "../query.ts";
import { oneLine, projectName, shortId, shortTime } from "../render.ts";
import { type CommandContext, dateOption, enumOption, present } from "./context.ts";

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
// (--all for every matching message), optionally filtered by --project / --since /
// --role / --prose.
export const searchCommand = (ctx: CommandContext): void => {
  const { db, values, positionals, limit, fail } = ctx;
  const query = positionals.slice(1).join(" ");
  if (!query) {
    fail("search: missing <query>");
    return;
  }
  const since = dateOption(values.since, "since", fail);
  if (!since.ok) return;
  const role = enumOption(values.role, "role", SEARCH_ROLES, fail);
  if (!role.ok) return;
  const hits = search(db, query, limit ?? 20, {
    project: values.project,
    since: since.value,
    role: role.value,
    prose: values.prose,
    all: values.all,
  });
  present(ctx, hits, {
    lines: (rows) => searchListing(rows, { all: values.all }),
    empty: "No matches.",
  });
};
