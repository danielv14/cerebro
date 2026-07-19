import { listThreads } from "../query.ts";
import { sessionsListing } from "../render.ts";
import type { CommandContext } from "./context.ts";

// The `sessions` command: list logical threads, newest first, optionally filtered
// by --project.
export const sessionsCommand = ({ db, io, values, limit, emitJson }: CommandContext): void => {
  const threads = listThreads(db, { project: values.project, limit: limit ?? 30 });
  if (values.json) {
    emitJson(threads);
    return;
  }
  if (threads.length === 0) {
    io.log("No sessions indexed yet. Run: cerebro index");
    return;
  }
  for (const line of sessionsListing(threads)) io.log(line);
};
