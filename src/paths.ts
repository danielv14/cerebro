import { homedir } from "node:os";
import { join } from "node:path";

export const claudeDir = (): string => process.env.CEREBRO_CLAUDE_DIR || join(homedir(), ".claude");

export const defaultDbPath = (): string =>
  process.env.CEREBRO_DB || join(claudeDir(), "cerebro", "archive.sqlite");

// The one expression on the TS side; package.json's `deploy` script builds the
// same path from its own bash literal, so the two must be changed together.
export const deployedBinaryPath = (): string =>
  join(process.env.CLAUDE_CONFIG_DIR || claudeDir(), "cerebro", "cerebro");
