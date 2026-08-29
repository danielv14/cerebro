import * as v from "valibot";
import { gitInfo } from "../git.ts";
import { DEFAULT_RELEVANT_LIMIT, type RelevantThread, relevantThreads } from "../relevance.ts";
import { oneLine, openedLine, projectName, shortDate, shortId } from "../render.ts";
import { CliError, flag, type OptionTable, positiveInt, text } from "./args.ts";
import { defineCommand } from "./command.ts";
import { readStdin } from "./helpers.ts";

const relevantThreadLine = (thread: RelevantThread): string =>
  `  ${shortId(thread.id)}  ${shortDate(thread.last_ts)}  ${projectName(thread.project_path)}  ${oneLine(thread.title ?? "(untitled)", 80)}`;

// The label flags which FTS tier the snippet came from.
const relevantSnippetLine = (snippet: string, fromSummary: boolean): string =>
  `      ${fromSummary ? "summary: " : "match:  "}${oneLine(snippet, 120)}`;

// The --context block's exact bytes land in the model's context, so the
// intro/footer are exported for their own pinned tests. The "Background only;
// ignore …" guardrail and the recall instructions are load-bearing. cerebro no
// longer ships a hook that emits this (see docs/hooks.md).

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

// A UserPromptSubmit payload is { prompt, cwd, ... }; an untrusted I/O boundary.
// Extra keys are ignored.
const HookPayloadSchema = v.object({
  prompt: v.optional(v.string()),
  cwd: v.optional(v.string()),
});

// Pure over the already-read raw string so it is unit-testable without fd-0
// plumbing. Degrades to an empty prompt and no cwd on any parse or validation
// failure, so a broken payload never injects context or spams the prompt.
export const parseHookPayload = (raw: string): { prompt: string; cwd: string | null } => {
  try {
    // On success both fields are string | undefined (never null); the fallbacks
    // cover the missing cases.
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
    // An explicit --cwd wins over the payload's; with neither, ranking stays
    // global. Deliberately NOT defaulted to the input's cwd: a manual
    // `relevant "..."` must rank exactly as it did before.
    let cwd = args.cwd || null;
    if (args.stdin) {
      // The fd-0 read is the only impure step. A failed read (no stdin) degrades
      // to "" too.
      const payload = parseHookPayload(readStdin());
      prompt = payload.prompt;
      cwd = args.cwd || payload.cwd;
    }
    if (!prompt) {
      // A hook whose payload carried no prompt must stay silent rather than
      // report an error into the model's context; a manual call gets the error.
      if (args.context) return {};
      throw new CliError("relevant: missing <prompt>");
    }
    // Same repo resolution as `recent`. gitInfo tolerates a null cwd (and a
    // deleted directory).
    const threads = relevantThreads(db, prompt, args.limit ?? DEFAULT_RELEVANT_LIMIT, now, {
      repoRoot: gitInfo(cwd).root,
      cwd,
    });
    return {
      json: threads,
      lines: threads.length > 0 ? relevantBlock(threads, { context: args.context }) : [],
      empty: "No related past sessions.",
      // Silent in --context mode so a consuming hook injects nothing.
      silentWhenEmpty: args.context,
    };
  },
});
