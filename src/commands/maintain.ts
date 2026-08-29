import type { OptionTable } from "./args.ts";
import { defineCommand } from "./command.ts";

const options = {} satisfies OptionTable;

export const maintainCommand = defineCommand({
  options,
  run: ({ db }) => {
    db.run("INSERT INTO messages_fts(messages_fts) VALUES('optimize')");
    db.run("INSERT INTO summaries_fts(summaries_fts) VALUES('optimize')");
    db.run("PRAGMA optimize");
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    return {
      lines: ["Maintenance done: FTS indexes optimized, planner stats refreshed, WAL truncated."],
    };
  },
});
