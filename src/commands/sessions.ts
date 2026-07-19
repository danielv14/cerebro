import { listThreads, type ThreadRow } from "../query.ts";
import { oneLine, projectName, shortId, shortTime } from "../render.ts";
import type { CommandContext } from "./context.ts";

// Line 1 of a `sessions` thread row: no leading indent, wall-clock time, the message
// count, the project name, then resume and "[body deleted]" suffixes. The
// "+N resume(s)" suffix appears only when the thread has resumes, and
// "[body deleted]" only when the underlying source is gone.
const sessionThreadLine = (thread: {
  id: string;
  last_ts: string | null;
  msgs: number;
  sessions_in_thread: number;
  project_path: string | null;
  body_available: number;
}): string => {
  const resumes =
    thread.sessions_in_thread > 1 ? ` +${thread.sessions_in_thread - 1} resume(s)` : "";
  const deleted = thread.body_available === 0 ? "  [body deleted]" : "";
  return `${shortId(thread.id)}  ${shortTime(thread.last_ts)}  ${String(thread.msgs).padStart(4)} msgs  ${projectName(thread.project_path)}${resumes}${deleted}`;
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

// The `sessions` command: list logical threads, newest first, optionally filtered
// by --project.
export const sessionsCommand = ({ db, io, values, limit, emitJson }: CommandContext): void => {
  const threads = listThreads(db, { project: values.project, limit: limit ?? 30 });
  if (values.json) {
    emitJson(threads);
    return;
  }
  if (threads.length === 0) {
    io.log("No sessions indexed yet. Run: cerebro index");
    return;
  }
  for (const line of sessionsListing(threads)) io.log(line);
};
