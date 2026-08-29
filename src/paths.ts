import { homedir } from "node:os";
import { join } from "node:path";

export const claudeDir = (): string => process.env.CEREBRO_CLAUDE_DIR || join(homedir(), ".claude");

export const defaultDbPath = (): string =>
  process.env.CEREBRO_DB || join(claudeDir(), "cerebro", "archive.sqlite");
