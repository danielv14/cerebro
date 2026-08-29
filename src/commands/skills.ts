import { oneLine, shortDate } from "../render.ts";
import { type SkillUsage, skillUsage } from "../skills.ts";
import { flag, isoDate, type OptionTable, positiveInt } from "./args.ts";
import { defineCommand } from "./command.ts";

const NAME_WIDTH = 34;
const COUNT_WIDTH = 7;
const count = (value: string | number): string => String(value).padStart(COUNT_WIDTH);

// The name is truncated to its column: one long plugin-qualified name must not
// shift every count on its row.
export const skillsListing = (usage: SkillUsage): string[] => {
  const names = `name${usage.distinct === 1 ? "" : "s"}`;
  const scope =
    usage.rows.length < usage.distinct
      ? `top ${usage.rows.length} of ${usage.distinct} ${names}`
      : `${usage.distinct} ${names}`;
  const lines = [
    `${scope}, ${shortDate(usage.from)} .. ${shortDate(usage.to)} (built-in commands included; sub is the subagent part of total)`,
    `${"name".padEnd(NAME_WIDTH)}${count("slash")}${count("model")}${count("total")}${count("sub")}  last`,
  ];
  for (const row of usage.rows) {
    lines.push(
      `${oneLine(row.name, NAME_WIDTH).padEnd(NAME_WIDTH)}${count(row.slash)}${count(row.model)}${count(row.total)}${count(row.sidechain)}  ${shortDate(row.lastTs)}`,
    );
  }
  return lines;
};

// No default limit, unlike the listings: a trimmed tail silently turns
// rarely-called skills into never-called ones.
const options = {
  since: isoDate(),
  limit: positiveInt(),
  json: flag(),
} satisfies OptionTable;

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
