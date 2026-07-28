import type { OptionTable } from "./args.ts";
import { defineCommand } from "./command.ts";

const options = {} satisfies OptionTable;

// The `maintain` command. Periodic housekeeping: the FTS indexes are fed by
// thousands of tiny incremental transactions and fragment over time; 'optimize'
// merges their b-trees. PRAGMA optimize refreshes the query planner's stats, and
// the truncating checkpoint folds the WAL back into the main file.
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
