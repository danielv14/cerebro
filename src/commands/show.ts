import { showFull, showOutline, showRange } from "../render.ts";
import { threadMessages } from "../thread.ts";
import { type CommandContext, resolveOrFail } from "./context.ts";

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
