import { homedir } from "node:os";
import { join } from "node:path";

// cerebro's own home: the archive and deployed binary live under
// $CEREBRO_CLAUDE_DIR/cerebro (default ~/.claude/cerebro) regardless of which
// sources are indexed. Source-specific discovery lives with each adapter under
// src/sources/ (the Claude Code projects walk is src/sources/claude-code.ts).

export const claudeDir = (): string => process.env.CEREBRO_CLAUDE_DIR || join(homedir(), ".claude");

export const defaultDbPath = (): string =>
  process.env.CEREBRO_DB || join(claudeDir(), "cerebro", "archive.sqlite");
