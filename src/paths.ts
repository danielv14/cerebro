import { homedir } from "node:os";
import { join } from "node:path";

export const claudeDir = (): string => process.env.CEREBRO_CLAUDE_DIR || join(homedir(), ".claude");

export const defaultDbPath = (): string =>
  process.env.CEREBRO_DB || join(claudeDir(), "cerebro", "archive.sqlite");

// One expression so doctor and the deploy script cannot disagree about the path.
export const deployedBinaryPath = (): string =>
  join(process.env.CLAUDE_CONFIG_DIR || claudeDir(), "cerebro", "cerebro");
