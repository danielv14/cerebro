import { oneLine, openedLine, projectName, shortDate, shortId } from "../render.ts";
import { recentThreads, type ThreadRow, threadOpeningPrompt } from "../thread.ts";
import { flag, numeric, type OptionTable, positiveInt, text } from "./args.ts";
import { defineCommand } from "./command.ts";

const recentThreadLine = (thread: ThreadRow, opts: { showMsgs: boolean }): string => {
  const msgs = opts.showMsgs ? `${String(thread.msgs).padStart(4)} msgs  ` : "";
  return `  ${shortId(thread.id)}  ${shortDate(thread.last_ts)}  ${msgs}${oneLine(thread.title ?? "(untitled)", 90)}`;
};

// These exact bytes are injected into a model by the SessionStart hook, so the
// intro/footer are exported for pinned tests; the guardrail is load-bearing.

export const recentContextIntro = (repoLabel: string): string =>
  `Recent Claude Code sessions in this repo (${repoLabel}), from the cerebro archive. ` +
  "Background only; ignore if unrelated to the current task.";

export const recentContextFooter = (): string =>
  "\nIf the request overlaps with any of these, recall that work instead of starting over:\n" +
  "  cerebro show <id>          thread outline (add --full for the transcript)\n" +
  '  cerebro search "<terms>"   full-text search across all past sessions';

export const recentBlock = (
  rows: { thread: ThreadRow; opening: string | null }[],
  opts: { repoPath: string; days: number; context: boolean },
): string[] => {
  const repoLabel = projectName(opts.repoPath);
  const lines: string[] = [];
  lines.push(
    opts.context
      ? recentContextIntro(repoLabel)
      : `Recent sessions in ${repoLabel} (last ${opts.days} days):`,
  );
  for (const { thread, opening } of rows) {
    lines.push(recentThreadLine(thread, { showMsgs: !opts.context }));
    if (opening) lines.push(openedLine(opening));
  }
  lines.push(
    opts.context
      ? recentContextFooter()
      : '\nPull prior context: cerebro show <id>  |  cerebro search "<terms>"',
  );
  return lines;
};

const options = {
  cwd: text(),
  days: numeric({ min: 0, minExclusive: true, label: "a positive number" }),
  limit: positiveInt(),
  context: flag(),
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
      lines:
        rows.length > 0
          ? recentBlock(rows, { repoPath: repoRoot ?? cwd, days, context: args.context })
          : [],
      empty: "No recent sessions for this repo.",
      silentWhenEmpty: args.context,
    };
  },
});
