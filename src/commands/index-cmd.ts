import { dryRunIndex, runIndex } from "../indexer.ts";
import { dryRunReport, indexResult, rebuildResult } from "../render.ts";
import type { CommandContext } from "./context.ts";

// The `index` command: incremental by default; --full/--rebuild re-read everything
// (dedup keeps it idempotent); --dry-run reports the plan without writing. Named
// index-cmd.ts, not index.ts, so the file never doubles as a directory index import.
export const indexCommand = ({ db, io, values }: CommandContext): void => {
  if (values["dry-run"]) {
    // A rebuild reads exactly what --full reads; the dry run reports that plan.
    for (const line of dryRunReport(dryRunIndex(db, values.full || values.rebuild))) {
      io.log(line);
    }
    return;
  }
  if (values.rebuild) {
    for (const line of rebuildResult(runIndex(db, false, true))) io.log(line);
    return;
  }
  for (const line of indexResult(runIndex(db, values.full))) io.log(line);
};
