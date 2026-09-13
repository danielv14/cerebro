import { homedir } from "node:os";
import { join } from "node:path";

// Three bash copies of this path exist: the `deploy` script and both hook scripts.
// test/paths.test.ts runs each of them and fails when one drifts from this one,
// because the drift is otherwise silent (deploy installs where nothing looks).
export const claudeConfigDir = (): string =>
  process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

// Where the transcripts are read from: the config dir, unless a test or a one-off
// run points CEREBRO_CLAUDE_DIR at a fixture tree.
export const claudeDir = (): string => process.env.CEREBRO_CLAUDE_DIR || claudeConfigDir();

export const claudeProjectsDir = (): string => join(claudeDir(), "projects");

export const defaultDbPath = (): string =>
  process.env.CEREBRO_DB || join(claudeDir(), "cerebro", "archive.sqlite");

export const deployedBinaryPath = (): string => join(claudeConfigDir(), "cerebro", "cerebro");

export const settingsPath = (): string => join(claudeConfigDir(), "settings.json");
