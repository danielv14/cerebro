import { oneLine, shortId, shortTime } from "../render.ts";
import { type ThreadMessage, threadMessages } from "../thread.ts";
import { CliError, flag, messageRange, type OptionTable } from "./args.ts";
import { defineCommand } from "./command.ts";
import { resolveOrThrow } from "./helpers.ts";

// The shared header of `show` (outline and full): id + message count, with a blank
// line under it (the trailing "\n" plus io.log's own newline).
const threadHeader = (sessionId: string, count: number): string =>
  `Thread ${shortId(sessionId)}  ${count} message(s)\n`;

// `show` (outline): the header, then a numbered one-line-per-message digest, then the
// hint to open the full transcript.
export const showOutline = (sessionId: string, messages: ThreadMessage[]): string[] => {
  const lines: string[] = [threadHeader(sessionId, messages.length)];
  messages.forEach((message, i) => {
    const marker = message.is_sidechain ? "[subagent] " : "";
    lines.push(
      `${String(i + 1).padStart(3)}. ${message.role.padEnd(9)} ${shortTime(message.ts)}  ${marker}${oneLine(message.text, 110)}`,
    );
  });
  lines.push("\nFull transcript: cerebro show <id> --full");
  return lines;
};

// `show --full`: the header, then each message rendered verbatim under a separator
// header, with a blank line between messages.
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

// `show --range A..B`: a verbatim slice of the thread, numbered with the same
// ordinals as the outline (and as search's #N markers), so a search hit can be
// opened in place without pulling the whole transcript.
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

// --range's shape is validated by the option itself; whether it fits the thread is
// decided here, because only the command knows how long the thread is.
const options = {
  full: flag(),
  range: messageRange(),
  json: flag(),
} satisfies OptionTable;

// The `show` command: a thread as outline (default), full transcript (--full), or
// a verbatim slice in outline numbering (--range A..B).
export const showCommand = defineCommand({
  options,
  run: ({ db, args, rest }) => {
    const sessionId = resolveOrThrow(db, rest[0], "show");
    const messages = threadMessages(db, sessionId);

    // The slice is resolved BEFORE the output format is chosen, so
    // `--range A..B --json` returns the requested slice instead of the whole thread.
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
