import { gitInfo } from "../git.ts";
import { recentThreads } from "../query.ts";
import { recentBlock } from "../render.ts";
import { threadOpeningPrompt } from "../thread.ts";
import type { CommandContext } from "./context.ts";

// The `recent` command: threads recently active in one repo (by git root when the
// cwd is inside a repo, else by exact project path), for session-start context.
export const recentCommand = ({ db, io, values, limit, fail, emitJson }: CommandContext): void => {
  const cwd = values.cwd || process.cwd();
  const days = values.days ? Number(values.days) : 14;
  if (!Number.isFinite(days) || days <= 0) {
    fail(`--days must be a positive number (got "${values.days}")`);
    return;
  }
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const repoRoot = gitInfo(cwd).root;
  const threads = recentThreads(db, { repoRoot, cwd, since, limit: limit ?? 5 });

  if (values.json) {
    emitJson(threads.map((thread) => ({ ...thread, opening: threadOpeningPrompt(db, thread.id) })));
    return;
  }

  if (threads.length === 0) {
    // Silent in --context mode so the SessionStart hook injects nothing.
    if (!values.context) io.log("No recent sessions for this repo.");
    return;
  }

  // Fetch the opening prompt per thread here so render stays db-free.
  const rows = threads.map((thread) => ({
    thread,
    opening: threadOpeningPrompt(db, thread.id),
  }));
  for (const line of recentBlock(rows, {
    repoPath: repoRoot ?? cwd,
    days,
    context: values.context,
  })) {
    io.log(line);
  }
};
