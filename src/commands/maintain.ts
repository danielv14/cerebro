import type { CommandContext } from "./context.ts";

// The `maintain` command. Periodic housekeeping: the FTS indexes are fed by
// thousands of tiny incremental transactions and fragment over time; 'optimize'
// merges their b-trees. PRAGMA optimize refreshes the query planner's stats, and
// the truncating checkpoint folds the WAL back into the main file.
export const maintainCommand = ({ db, io }: CommandContext): void => {
  db.run("INSERT INTO messages_fts(messages_fts) VALUES('optimize')");
  db.run("INSERT INTO summaries_fts(summaries_fts) VALUES('optimize')");
  db.run("PRAGMA optimize");
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  io.log("Maintenance done: FTS indexes optimized, planner stats refreshed, WAL truncated.");
};
