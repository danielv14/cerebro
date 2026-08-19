import { shortDate } from "../render.ts";
import { type SkillUsage, skillUsage } from "../skills.ts";
import { flag, isoDate, numeric, type OptionTable } from "./args.ts";
import { defineCommand } from "./command.ts";

const NAME_WIDTH = 34;
const COUNT_WIDTH = 7;
const count = (value: string | number): string => String(value).padStart(COUNT_WIDTH);

// `skills` output: a header naming the window, a column header, then one row per
// skill. `sub` is a share of `total`, not a fourth column to add up, which the
// header says because the listing is read by agents as often as by people.
export const skillsListing = (usage: SkillUsage): string[] => {
  const scope =
    usage.rows.length < usage.distinct
      ? `top ${usage.rows.length} of ${usage.distinct} skills`
      : `${usage.distinct} skills`;
  const lines = [
    `${scope}, ${shortDate(usage.from)} .. ${shortDate(usage.to)} (sub = the part of total from subagent turns)`,
    `${"name".padEnd(NAME_WIDTH)}${count("slash")}${count("model")}${count("sub")}${count("total")}  last`,
  ];
  for (const row of usage.rows) {
    lines.push(
      `${row.name.padEnd(NAME_WIDTH)}${count(row.slash)}${count(row.model)}${count(row.sidechain)}${count(row.total)}  ${shortDate(row.lastTs)}`,
    );
  }
  return lines;
};

// No default limit, unlike the listings: the question this answers is which skills
// are unused, and a trimmed tail silently turns rarely-called skills into
// never-called ones. `--limit` is there when you only want the top of the list.
const options = {
  since: isoDate(),
  limit: numeric({ integer: true, min: 1, label: "a positive integer" }),
  json: flag(),
} satisfies OptionTable;

// The `skills` command: how often each skill was invoked, counted out of the archive.
export const skillsCommand = defineCommand({
  options,
  run: ({ db, args }) => {
    const usage = skillUsage(db, { since: args.since, limit: args.limit });
    return {
      json: usage,
      lines: usage.rows.length > 0 ? skillsListing(usage) : [],
      empty: "No skill calls in the archive. Run: cerebro index",
    };
  },
});
