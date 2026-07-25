import * as v from "valibot";
import { gitInfo } from "../git.ts";
import { type RelevantThread, relevantThreads } from "../query.ts";
import { oneLine, openedLine, projectName, shortDate, shortId } from "../render.ts";
import { type CommandContext, readStdin } from "./context.ts";

// Line 1 of a `relevant` thread row: id, date, project, title. Distinct from the
// `recent` / `sessions` rows.
const relevantThreadLine = (thread: {
  id: string;
  last_ts: string | null;
  project_path: string | null;
  title: string | null;
}): string =>
  `  ${shortId(thread.id)}  ${shortDate(thread.last_ts)}  ${projectName(thread.project_path)}  ${oneLine(thread.title ?? "(untitled)", 80)}`;

// The snippet follow-up line for a `relevant` row. The label flags which FTS tier the
// snippet came from: a curated summary outranks a raw-transcript match.
const relevantSnippetLine = (snippet: string, fromSummary: boolean): string =>
  `      ${fromSummary ? "summary: " : "match:  "}${oneLine(snippet, 120)}`;

// The agent-facing context block emitted under --context is cerebro's contract with
// the consuming UserPromptSubmit hook: these exact bytes are injected into the model
// on every prompt, so the intro/footer are exported for their own pinned tests. The
// "Background only; ignore …" guardrail and the recall instructions are load-bearing.

export const relevantContextIntro = (): string =>
  "Possibly relevant past Claude Code sessions (from the cerebro archive, matched " +
  "against this prompt). Background only; ignore any that do not actually relate.";

// The recall footer shared by both `relevant` branches (context and plain).
export const relevantFooter = (): string =>
  "\nTo recall one: cerebro show <id> (add --full for the transcript), " +
  'or cerebro search "<terms>".';

// `relevant` output: threads relevant to a prompt, summary-first. Each row carries
// its own opening and snippet (and which FTS tier the snippet is from). The context
// branch swaps the intro for the agent-facing one; the recall footer is shared.
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

// The accepted shape of the JSON a UserPromptSubmit hook pipes to `relevant
// --stdin` (the hook sends { prompt, cwd, ... }). `prompt` is what gets searched and
// `cwd` is the repo the prompt was typed in (a ranking boost, see relevantThreads);
// extra keys are ignored.
const HookPayloadSchema = v.object({
  prompt: v.optional(v.string()),
  cwd: v.optional(v.string()),
});

// Validate that hook stdin payload, pure over the already-read raw string so it is
// unit-testable without fd-0 plumbing. Degrades to an empty prompt and no cwd on any
// JSON-parse or validation failure (malformed JSON, missing prompt, non-string
// prompt), so a broken payload never injects context or spams the prompt, and a
// payload without a usable cwd ranks globally. This is cerebro's second untrusted I/O
// boundary (the first is the session JSONL in jsonl.ts).
export const parseHookPayload = (raw: string): { prompt: string; cwd: string | null } => {
  try {
    // HookPayloadSchema validates both fields as optional(string), so on success they
    // are string | undefined (never null); the fallbacks cover the missing cases.
    const parsed = v.safeParse(HookPayloadSchema, JSON.parse(raw));
    if (!parsed.success) return { prompt: "", cwd: null };
    return { prompt: parsed.output.prompt ?? "", cwd: parsed.output.cwd || null };
  } catch {
    return { prompt: "", cwd: null };
  }
};

// The `relevant` command: past threads relevant to a prompt (summary tier first),
// for per-prompt context injection.
export const relevantCommand = ({
  db,
  io,
  values,
  positionals,
  limit,
  emitJson,
}: CommandContext): void => {
  // --stdin reads the prompt from a hook's JSON payload (UserPromptSubmit
  // sends { prompt, cwd, ... } on stdin), so the hook needs no jq or wrapper.
  let prompt = positionals.slice(1).join(" ");
  // The directory the prompt was typed in, used only to boost same-repo threads.
  // An explicit --cwd wins over the payload's (manual use and tests); with neither,
  // ranking stays global. Deliberately NOT defaulted to process.cwd(): a manual
  // `relevant "..."` must rank exactly as it did before.
  let cwd = values.cwd || null;
  if (values.stdin) {
    // The fd-0 read (readStdin, shared with digest write) is the only impure step;
    // the parsing/validation is in the pure parseHookPayload. A failed read (no
    // stdin) degrades to "" too.
    const payload = parseHookPayload(readStdin());
    prompt = payload.prompt;
    cwd = values.cwd || payload.cwd;
  }
  if (!prompt) {
    if (!values.context) {
      io.error("relevant: missing <prompt>");
      io.setExitCode(1);
    }
    return;
  }
  // Same repo resolution as `recent`: the git root when the cwd is inside a repo,
  // else the exact path. gitInfo tolerates a null cwd (and a deleted directory).
  const threads = relevantThreads(db, prompt, limit ?? 3, Date.now(), {
    repoRoot: gitInfo(cwd).root,
    cwd,
  });
  if (values.json) {
    emitJson(threads);
    return;
  }
  if (threads.length === 0) {
    // Silent in --context mode so the UserPromptSubmit hook injects nothing.
    if (!values.context) io.log("No related past sessions.");
    return;
  }
  for (const line of relevantBlock(threads, { context: values.context })) io.log(line);
};
