import { oneLine, projectName, shortId, shortTime } from "../render.ts";
import { listThreads, type ThreadRow } from "../thread.ts";
import { flag, isoDate, type OptionTable, positiveInt, text } from "./args.ts";
import { defineCommand } from "./command.ts";

const sessionThreadLine = (thread: ThreadRow): string => {
  const branch = thread.git_branch ? ` @${thread.git_branch}` : "";
  const resumes =
    thread.sessions_in_thread > 1 ? ` +${thread.sessions_in_thread - 1} resume(s)` : "";
  const deleted = thread.body_available === 0 ? "  [body deleted]" : "";
  return `${shortId(thread.id)}  ${shortTime(thread.last_ts)}  ${String(thread.msgs).padStart(4)} msgs  ${projectName(thread.project_path)}${branch}${resumes}${deleted}`;
};

export const sessionsListing = (threads: ThreadRow[]): string[] => {
  const lines: string[] = [];
  for (const thread of threads) {
    lines.push(sessionThreadLine(thread));
    lines.push(`    ${oneLine(thread.title ?? "(untitled)", 120)}`);
  }
  return lines;
};

const options = {
  project: text(),
  branch: text(),
  since: isoDate(),
  limit: positiveInt(),
  json: flag(),
} satisfies OptionTable;

export const sessionsCommand = defineCommand({
  options,
  run: ({ db, args }) => {
    const threads = listThreads(db, {
      project: args.project,
      branch: args.branch,
      since: args.since,
      limit: args.limit ?? 30,
    });
    return {
      json: threads,
      lines: threads.length > 0 ? sessionsListing(threads) : [],
      empty: "No sessions indexed yet. Run: cerebro index",
    };
  },
});
