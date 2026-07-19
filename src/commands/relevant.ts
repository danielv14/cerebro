import { readFileSync } from "node:fs";
import * as v from "valibot";
import { relevantThreads } from "../query.ts";
import { relevantBlock } from "../render.ts";
import type { CommandContext } from "./context.ts";

// The accepted shape of the JSON a UserPromptSubmit hook pipes to `relevant
// --stdin` (the hook sends { prompt, cwd, ... }). Only `prompt` is read; extra keys
// are ignored.
const HookPayloadSchema = v.object({ prompt: v.optional(v.string()) });

// Validate that hook stdin payload, pure over the already-read raw string so it is
// unit-testable without fd-0 plumbing. Degrades to an empty prompt on any JSON-parse
// or validation failure (malformed JSON, missing prompt, non-string prompt), exactly
// as the previous inline cast did, so a broken payload never injects context or
// spams the prompt. This is cerebro's second untrusted I/O boundary (the first is the
// session JSONL in jsonl.ts).
export const parseHookPayload = (raw: string): { prompt: string } => {
  try {
    // HookPayloadSchema validates prompt as optional(string), so on success it is
    // string | undefined (never null); ?? "" covers the missing case.
    const parsed = v.safeParse(HookPayloadSchema, JSON.parse(raw));
    return { prompt: parsed.success ? (parsed.output.prompt ?? "") : "" };
  } catch {
    return { prompt: "" };
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
  if (values.stdin) {
    // The fd-0 read is the only impure step; the parsing/validation is in the
    // pure parseHookPayload. A failed read (no stdin) degrades to "" too.
    let raw = "";
    try {
      raw = readFileSync(0, "utf8");
    } catch {
      raw = "";
    }
    prompt = parseHookPayload(raw).prompt;
  }
  if (!prompt) {
    if (!values.context) {
      io.error("relevant: missing <prompt>");
      io.setExitCode(1);
    }
    return;
  }
  const threads = relevantThreads(db, prompt, limit ?? 3);
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
