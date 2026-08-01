import { listThreads, type ThreadRow } from "../query.ts";
import { oneLine, projectName, shortId, shortTime } from "../render.ts";
import { flag, isoDate, numeric, type OptionTable, text } from "./args.ts";
import { defineCommand } from "./command.ts";

// Line 1 of a `sessions` thread row: no leading indent, wall-clock time, the message
// count, the project name with the thread's branch as an @suffix when one was
// recorded, then resume and "[body deleted]" suffixes. The "+N resume(s)" suffix
// appears only when the thread has resumes, and "[body deleted]" only when the
// underlying source is gone.
const sessionThreadLine = (thread: {
  id: string;
  last_ts: string | null;
  msgs: number;
  sessions_in_thread: number;
  project_path: string | null;
  git_branch: string | null;
  body_available: number;
}): string => {
  const branch = thread.git_branch ? ` @${thread.git_branch}` : "";
  const resumes =
    thread.sessions_in_thread > 1 ? ` +${thread.sessions_in_thread - 1} resume(s)` : "";
  const deleted = thread.body_available === 0 ? "  [body deleted]" : "";
  return `${shortId(thread.id)}  ${shortTime(thread.last_ts)}  ${String(thread.msgs).padStart(4)} msgs  ${projectName(thread.project_path)}${branch}${resumes}${deleted}`;
};

// `sessions` output: the thread row plus the title on its own follow-up line
// (truncated at 120). No intro, no footer.
export const sessionsListing = (threads: ThreadRow[]): string[] => {
  const lines: string[] = [];
  for (const thread of threads) {
    lines.push(sessionThreadLine(thread));
    lines.push(`    ${oneLine(thread.title ?? "(untitled)", 120)}`);
  }
  return lines;
};

// Same anchored-ISO-date shape as search --since, from the same validator, rather
// than a second date syntax.
const options = {
  project: text(),
  branch: text(),
  since: isoDate(),
  limit: numeric({ integer: true, min: 1, label: "a positive integer" }),
  json: flag(),
} satisfies OptionTable;

// The `sessions` command: list logical threads, newest first, optionally filtered
// by --project, --branch, and --since.
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
