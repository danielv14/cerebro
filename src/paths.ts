import { homedir } from "node:os";
import { join } from "node:path";

// cerebro's own home, regardless of which sources are indexed; source-specific
// discovery lives with each adapter under src/sources/.

export const claudeDir = (): string => process.env.CEREBRO_CLAUDE_DIR || join(homedir(), ".claude");

export const defaultDbPath = (): string =>
  process.env.CEREBRO_DB || join(claudeDir(), "cerebro", "archive.sqlite");
