import { homedir } from "node:os";
import { join } from "node:path";

// Where Claude Code keeps its config: settings.json, and the directory `bun run
// deploy` installs cerebro's binary and hook scripts into. CLAUDE_CONFIG_DIR is
// Claude Code's own override. package.json's `deploy` script and both hook
// scripts build this same path from their own bash literals, so all four must be
// changed together; doctor looking somewhere else than deploy writes is the bug
// this single expression exists to prevent.
export const claudeConfigDir = (): string =>
  process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

// Where the session transcripts live. Same directory in normal use;
// CEREBRO_CLAUDE_DIR points a test or a one-off run at a fixture tree instead.
export const claudeDir = (): string => process.env.CEREBRO_CLAUDE_DIR || claudeConfigDir();

export const claudeProjectsDir = (): string => join(claudeDir(), "projects");

export const defaultDbPath = (): string =>
  process.env.CEREBRO_DB || join(claudeDir(), "cerebro", "archive.sqlite");

export const deployedBinaryPath = (): string => join(claudeConfigDir(), "cerebro", "cerebro");

export const settingsPath = (): string => join(claudeConfigDir(), "settings.json");
