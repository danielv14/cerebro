import { DEFAULT_RELEVANT_LIMIT, type RelevantThread, relevantThreads } from "../relevance.ts";
import { oneLine, openedLine, projectName, shortDate, shortId } from "../render.ts";
import { CliError, flag, type OptionTable, positiveInt, text } from "./args.ts";
import { defineCommand } from "./command.ts";

const relevantThreadLine = (thread: RelevantThread): string =>
  `  ${shortId(thread.id)}  ${shortDate(thread.last_ts)}  ${projectName(thread.project_path)}  ${oneLine(thread.title ?? "(untitled)", 80)}`;

const relevantSnippetLine = (snippet: string, fromSummary: boolean): string =>
  `      ${fromSummary ? "summary: " : "match:  "}${oneLine(snippet, 120)}`;

export const relevantBlock = (threads: RelevantThread[]): string[] => {
  const lines: string[] = ["Related past sessions:"];
  for (const thread of threads) {
    lines.push(relevantThreadLine(thread));
    if (thread.opening) lines.push(openedLine(thread.opening));
    if (thread.snippet) lines.push(relevantSnippetLine(thread.snippet, thread.fromSummary));
  }
  lines.push(
    "\nTo recall one: cerebro show <id> (add --full for the transcript), " +
      'or cerebro search "<terms>".',
  );
  return lines;
};

const options = {
  cwd: text(),
  limit: positiveInt(),
  json: flag(),
} satisfies OptionTable;

export const relevantCommand = defineCommand({
  options,
  run: ({ db, args, rest, now, resolveGit }) => {
    const prompt = rest.join(" ");
    if (!prompt) throw new CliError("relevant: missing <prompt>");
    // Deliberately NOT defaulted to the invoking directory the way `recent` is:
    // a manual `relevant "..."` must rank globally.
    const cwd = args.cwd || null;
    const threads = relevantThreads(db, prompt, args.limit ?? DEFAULT_RELEVANT_LIMIT, now, {
      repoRoot: resolveGit(cwd).root,
      cwd,
    });
    return {
      json: threads,
      lines: threads.length > 0 ? relevantBlock(threads) : [],
      empty: "No related past sessions.",
    };
  },
});
