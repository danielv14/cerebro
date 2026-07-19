import { oneLine, shortId, shortTime } from "../render.ts";
import { type ThreadMessage, threadMessages } from "../thread.ts";
import { type CommandContext, resolveOrFail } from "./context.ts";

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

// The `show` command: a thread as outline (default), full transcript (--full), or
// a verbatim slice in outline numbering (--range A..B).
export const showCommand = ({
  db,
  io,
  values,
  positionals,
  fail,
  emitJson,
}: CommandContext): void => {
  const sessionId = resolveOrFail(db, positionals[1], "show", fail);
  if (!sessionId) return;
  const messages = threadMessages(db, sessionId);

  // --range is resolved (and validated) BEFORE the output format is chosen,
  // so `--range A..B --json` returns the requested slice as JSON instead of
  // silently dumping the whole thread.
  let slice = messages;
  let from = 1;
  if (values.range !== undefined) {
    // --range A..B (or a single N): a verbatim slice in outline numbering,
    // the jump target for search's #N ordinals.
    const match = values.range.match(/^(\d+)(?:\.\.(\d+))?$/);
    const start = match ? Number(match[1]) : 0;
    const to = match?.[2] ? Number(match[2]) : start;
    if (!match || start < 1 || to < start) {
      fail(`--range must be N or A..B with 1 <= A <= B (got "${values.range}")`);
      return;
    }
    if (start > messages.length) {
      fail(`--range starts at ${start} but the thread has ${messages.length} message(s)`);
      return;
    }
    from = start;
    slice = messages.slice(start - 1, Math.min(to, messages.length));
  }

  if (values.json) {
    emitJson({ id: sessionId, total: messages.length, from, messages: slice });
    return;
  }
  if (values.range !== undefined) {
    for (const line of showRange(sessionId, slice, { from, total: messages.length })) {
      io.log(line);
    }
    return;
  }
  const lines = values.full ? showFull(sessionId, messages) : showOutline(sessionId, messages);
  for (const line of lines) io.log(line);
};
