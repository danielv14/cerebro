import { oneLine, openedLine, projectName, shortDate, shortId } from "../render.ts";
import { recentThreads, type ThreadRow, threadOpeningPrompt } from "../thread.ts";
import { flag, numeric, type OptionTable, positiveInt, text } from "./args.ts";
import { defineCommand } from "./command.ts";

const recentThreadLine = (thread: ThreadRow): string =>
  `  ${shortId(thread.id)}  ${shortDate(thread.last_ts)}  ${String(thread.msgs).padStart(4)} msgs  ${oneLine(thread.title ?? "(untitled)", 90)}`;

export const recentBlock = (
  rows: { thread: ThreadRow; opening: string | null }[],
  opts: { repoPath: string; days: number },
): string[] => {
  const lines: string[] = [
    `Recent sessions in ${projectName(opts.repoPath)} (last ${opts.days} days):`,
  ];
  for (const { thread, opening } of rows) {
    lines.push(recentThreadLine(thread));
    if (opening) lines.push(openedLine(opening));
  }
  lines.push('\nPull prior context: cerebro show <id>  |  cerebro search "<terms>"');
  return lines;
};

const options = {
  cwd: text(),
  days: numeric({ min: 0, minExclusive: true, label: "a positive number" }),
  limit: positiveInt(),
  json: flag(),
} satisfies OptionTable;

export const recentCommand = defineCommand({
  options,
  run: ({ db, args, now, cwd: invokedIn, resolveGit }) => {
    const cwd = args.cwd || invokedIn;
    const days = args.days ?? 14;
    const since = new Date(now - days * 86_400_000).toISOString();
    const repoRoot = resolveGit(cwd).root;
    const threads = recentThreads(db, { repoRoot, cwd, since, limit: args.limit ?? 5 });
    const rows = threads.map((thread) => ({
      thread,
      opening: threadOpeningPrompt(db, thread.id),
    }));

    return {
      json: rows.map(({ thread, opening }) => ({ ...thread, opening })),
      lines: rows.length > 0 ? recentBlock(rows, { repoPath: repoRoot ?? cwd, days }) : [],
      empty: "No recent sessions for this repo.",
    };
  },
});
