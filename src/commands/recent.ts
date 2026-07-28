import { gitInfo } from "../git.ts";
import { recentThreads, type ThreadRow } from "../query.ts";
import { oneLine, openedLine, projectName, shortDate, shortId } from "../render.ts";
import { threadOpeningPrompt } from "../thread.ts";
import { flag, numeric, type OptionTable, text } from "./args.ts";
import { defineCommand } from "./command.ts";

// Line 1 of a `recent` thread row. `showMsgs: false` (the --context branch) drops
// the "N msgs" column; otherwise the count is right-padded to width 4. The title is
// truncated at 90 columns in both branches.
const recentThreadLine = (
  thread: { id: string; last_ts: string | null; msgs: number; title: string | null },
  opts: { showMsgs: boolean },
): string => {
  const msgs = opts.showMsgs ? `${String(thread.msgs).padStart(4)} msgs  ` : "";
  return `  ${shortId(thread.id)}  ${shortDate(thread.last_ts)}  ${msgs}${oneLine(thread.title ?? "(untitled)", 90)}`;
};

// The agent-facing context block emitted under --context is cerebro's contract with
// the consuming SessionStart hook: these exact bytes are injected into the model, so
// the intro/footer are exported for their own pinned tests. The "Background only;
// ignore …" guardrail (which stops injected history derailing the task) and the
// recall instructions are load-bearing.

export const recentContextIntro = (repoLabel: string): string =>
  `Recent Claude Code sessions in this repo (${repoLabel}), from the cerebro archive. ` +
  "Background only; ignore if unrelated to the current task.";

export const recentContextFooter = (): string =>
  "\nIf the request overlaps with any of these, recall that work instead of starting over:\n" +
  "  cerebro show <id>          thread outline (add --full for the transcript)\n" +
  '  cerebro search "<terms>"   full-text search across all past sessions';

// `recent` output: repo-scoped recent threads. The context branch emits the
// agent-facing block (intro + rows without the msg count + recall footer); the plain
// branch shows the msg count and a human header/footer. `repoPath` is the matched
// git root or cwd; the label is derived here. Openings are passed in so this stays
// db-free.
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

// Fractional days are allowed: --days multiplies into a millisecond cutoff, so
// 1.5 is a meaningful window (unlike a row limit).
const options = {
  cwd: text(),
  days: numeric({ min: 0, minExclusive: true, label: "a positive number" }),
  limit: numeric({ integer: true, min: 1, label: "a positive integer" }),
  context: flag(),
  json: flag(),
} satisfies OptionTable;

// The `recent` command: threads recently active in one repo (by git root when the
// cwd is inside a repo, else by exact project path), for session-start context.
export const recentCommand = defineCommand({
  options,
  run: ({ db, args }) => {
    const cwd = args.cwd || process.cwd();
    const days = args.days ?? 14;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const repoRoot = gitInfo(cwd).root;
    const threads = recentThreads(db, { repoRoot, cwd, since, limit: args.limit ?? 5 });
    // The opening prompt is fetched here so the render stays db-free. JSON carries
    // it as a field; the listing puts it on its own follow-up line.
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
      // Silent in --context mode so the SessionStart hook injects nothing.
      silentWhenEmpty: args.context,
    };
  },
});
