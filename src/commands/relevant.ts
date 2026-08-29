import * as v from "valibot";
import { gitInfo } from "../git.ts";
import { DEFAULT_RELEVANT_LIMIT, type RelevantThread, relevantThreads } from "../relevance.ts";
import { oneLine, openedLine, projectName, shortDate, shortId } from "../render.ts";
import { CliError, flag, type OptionTable, positiveInt, text } from "./args.ts";
import { defineCommand } from "./command.ts";
import { readStdin } from "./helpers.ts";

const relevantThreadLine = (thread: RelevantThread): string =>
  `  ${shortId(thread.id)}  ${shortDate(thread.last_ts)}  ${projectName(thread.project_path)}  ${oneLine(thread.title ?? "(untitled)", 80)}`;

const relevantSnippetLine = (snippet: string, fromSummary: boolean): string =>
  `      ${fromSummary ? "summary: " : "match:  "}${oneLine(snippet, 120)}`;

// These exact bytes land in a model's context, so the intro/footer are exported
// for their own pinned tests; the "Background only" guardrail is load-bearing.

export const relevantContextIntro = (): string =>
  "Possibly relevant past Claude Code sessions (from the cerebro archive, matched " +
  "against this prompt). Background only; ignore any that do not actually relate.";

export const relevantFooter = (): string =>
  "\nTo recall one: cerebro show <id> (add --full for the transcript), " +
  'or cerebro search "<terms>".';

export const relevantBlock = (threads: RelevantThread[], opts: { context: boolean }): string[] => {
  const lines: string[] = [];
  lines.push(opts.context ? relevantContextIntro() : "Related past sessions:");
  for (const thread of threads) {
    lines.push(relevantThreadLine(thread));
    if (thread.opening) lines.push(openedLine(thread.opening));
    if (thread.snippet) lines.push(relevantSnippetLine(thread.snippet, thread.fromSummary));
  }
  lines.push(relevantFooter());
  return lines;
};

// Untrusted I/O boundary: a UserPromptSubmit payload. Extra keys ignored.
const HookPayloadSchema = v.object({
  prompt: v.optional(v.string()),
  cwd: v.optional(v.string()),
});

// Degrades to an empty prompt and no cwd on any failure, so a broken payload
// never injects context or spams the prompt.
export const parseHookPayload = (raw: string): { prompt: string; cwd: string | null } => {
  try {
    const parsed = v.safeParse(HookPayloadSchema, JSON.parse(raw));
    if (!parsed.success) return { prompt: "", cwd: null };
    return { prompt: parsed.output.prompt ?? "", cwd: parsed.output.cwd || null };
  } catch {
    return { prompt: "", cwd: null };
  }
};

const options = {
  cwd: text(),
  stdin: flag(),
  context: flag(),
  limit: positiveInt(),
  json: flag(),
} satisfies OptionTable;

export const relevantCommand = defineCommand({
  options,
  run: ({ db, args, rest, now }) => {
    let prompt = rest.join(" ");
    // Deliberately NOT defaulted to the input's cwd: a manual `relevant "..."`
    // must rank globally, exactly as before.
    let cwd = args.cwd || null;
    if (args.stdin) {
      const payload = parseHookPayload(readStdin());
      prompt = payload.prompt;
      cwd = args.cwd || payload.cwd;
    }
    if (!prompt) {
      // A hook payload without a prompt must stay silent rather than report an
      // error into the model's context; a manual call gets the error.
      if (args.context) return {};
      throw new CliError("relevant: missing <prompt>");
    }
    const threads = relevantThreads(db, prompt, args.limit ?? DEFAULT_RELEVANT_LIMIT, now, {
      repoRoot: gitInfo(cwd).root,
      cwd,
    });
    return {
      json: threads,
      lines: threads.length > 0 ? relevantBlock(threads, { context: args.context }) : [],
      empty: "No related past sessions.",
      silentWhenEmpty: args.context,
    };
  },
});
