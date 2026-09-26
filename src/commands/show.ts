import { oneLine, shortId, shortTime } from "../render.ts";
import { type ThreadMessage, threadMessages } from "../thread.ts";
import { CliError, flag, messageRange, type OptionTable, text } from "./args.ts";
import { defineCommand } from "./command.ts";
import { resolveOrThrow } from "./helpers.ts";

const threadHeader = (sessionId: string, count: number): string =>
  `Thread ${shortId(sessionId)}  ${count} message(s)\n`;

// The outline is capped at head + tail. The tail keeps its true ordinals so
// the numbering stays identical to --range and search's #N.
const OUTLINE_HEAD = 50;
const OUTLINE_TAIL = 50;

const outlineLine = (message: ThreadMessage, ordinal: number): string => {
  const marker = message.is_sidechain ? "[subagent] " : "";
  return `${String(ordinal).padStart(3)}. ${message.role.padEnd(9)} ${shortTime(message.ts)}  ${marker}${oneLine(message.text, 110)}`;
};

export const showOutline = (sessionId: string, messages: ThreadMessage[]): string[] => {
  const lines: string[] = [threadHeader(sessionId, messages.length)];
  const pushLines = (start: number, end: number) => {
    for (let i = start; i < end; i++) lines.push(outlineLine(messages[i]!, i + 1));
  };
  if (messages.length <= OUTLINE_HEAD + OUTLINE_TAIL) {
    pushLines(0, messages.length);
  } else {
    const omitted = messages.length - OUTLINE_HEAD - OUTLINE_TAIL;
    pushLines(0, OUTLINE_HEAD);
    lines.push(
      `  … ${omitted} message(s) omitted (#${OUTLINE_HEAD + 1}..#${messages.length - OUTLINE_TAIL}), open a slice with: cerebro show <id> --range A..B`,
    );
    pushLines(messages.length - OUTLINE_TAIL, messages.length);
  }
  lines.push("\nFull transcript: cerebro show <id> --full");
  return lines;
};

export const showFull = (sessionId: string, messages: ThreadMessage[]): string[] => {
  const lines: string[] = [threadHeader(sessionId, messages.length)];
  for (const message of messages) {
    const tag = message.is_sidechain ? " · subagent" : "";
    lines.push(`──── ${message.role}${tag} · ${shortTime(message.ts)} ────`);
    lines.push(message.text);
    lines.push("");
  }
  return lines;
};

export const showRange = (
  sessionId: string,
  slice: ThreadMessage[],
  opts: { from: number; total: number },
): string[] => {
  const to = opts.from + slice.length - 1;
  const lines: string[] = [
    `Thread ${shortId(sessionId)}  showing ${opts.from}..${to} of ${opts.total} message(s)\n`,
  ];
  slice.forEach((message, i) => {
    const tag = message.is_sidechain ? " · subagent" : "";
    lines.push(`──── #${opts.from + i} ${message.role}${tag} · ${shortTime(message.ts)} ────`);
    lines.push(message.text);
    lines.push("");
  });
  return lines;
};

export interface GrepMatch extends ThreadMessage {
  ordinal: number;
}

// A plain case-insensitive substring, not FTS: the point is every turn that
// mentions the text, in thread order, with the numbering --range takes.
export const grepMessages = (messages: ThreadMessage[], needle: string): GrepMatch[] => {
  const lowered = needle.toLowerCase();
  return messages.flatMap((message, i) =>
    message.text.toLowerCase().includes(lowered) ? [{ ...message, ordinal: i + 1 }] : [],
  );
};

export const showGrep = (
  sessionId: string,
  matches: GrepMatch[],
  opts: { needle: string; total: number },
): string[] => {
  if (matches.length === 0) {
    return [`No message in thread ${shortId(sessionId)} contains "${opts.needle}".`];
  }
  return [
    `Thread ${shortId(sessionId)}  ${matches.length} of ${opts.total} message(s) contain "${opts.needle}"\n`,
    ...matches.map((match) => outlineLine(match, match.ordinal)),
    "\nOpen one: cerebro show <id> --range <n>",
  ];
};

const options = {
  full: flag(),
  range: messageRange(),
  grep: text(),
  json: flag(),
} satisfies OptionTable;

export const showCommand = defineCommand({
  options,
  run: ({ db, args, rest }) => {
    const sessionId = resolveOrThrow(db, rest[0], "show");
    const messages = threadMessages(db, sessionId);

    if (args.grep !== undefined) {
      if (args.full || args.range)
        throw new CliError("show: --grep cannot be combined with --full or --range");
      const matches = grepMessages(messages, args.grep);
      return {
        json: { id: sessionId, total: messages.length, matches },
        lines: showGrep(sessionId, matches, { needle: args.grep, total: messages.length }),
      };
    }

    // Resolved BEFORE the output format is chosen, so `--range A..B --json`
    // returns the requested slice instead of the whole thread.
    let slice = messages;
    let from = 1;
    if (args.range) {
      if (args.range.from > messages.length) {
        throw new CliError(
          `--range starts at ${args.range.from} but the thread has ${messages.length} message(s)`,
        );
      }
      from = args.range.from;
      slice = messages.slice(from - 1, Math.min(args.range.to, messages.length));
    }

    const json = { id: sessionId, total: messages.length, from, messages: slice };
    if (args.range) {
      return { json, lines: showRange(sessionId, slice, { from, total: messages.length }) };
    }
    return {
      json,
      lines: args.full ? showFull(sessionId, messages) : showOutline(sessionId, messages),
    };
  },
});
