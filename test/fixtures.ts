import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A throwaway ~/.claude directory for one test. Point CEREBRO_CLAUDE_DIR at
// `claudeRoot` and write session files under `projects`.
export interface TempClaude {
  claudeRoot: string;
  projects: string;
  cleanup: () => void;
}

export const makeClaudeDir = (): TempClaude => {
  const claudeRoot = fs.mkdtempSync(join(tmpdir(), "cerebro-test-"));
  const projects = join(claudeRoot, "projects");
  fs.mkdirSync(projects, { recursive: true });
  return {
    claudeRoot,
    projects,
    cleanup: () => fs.rmSync(claudeRoot, { recursive: true, force: true }),
  };
};

// Write a top-level session file: projects/<projectDir>/<sessionId>.jsonl
export const writeSession = (
  projects: string,
  projectDir: string,
  sessionId: string,
  lines: unknown[],
): string => {
  const dir = join(projects, projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
};

// Write a subagent transcript: projects/<projectDir>/<parentSession>/subagents/<name>.jsonl
export const writeSubagent = (
  projects: string,
  projectDir: string,
  parentSession: string,
  name: string,
  lines: unknown[],
): string => {
  const dir = join(projects, projectDir, parentSession, "subagents");
  fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.jsonl`);
  fs.writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
};

// Append a raw, already-serialized chunk to a file (for partial-write / incremental tests).
export const appendRaw = (path: string, raw: string): void => {
  fs.appendFileSync(path, raw);
};

const BASE = Date.parse("2026-01-01T10:00:00.000Z");
// Deterministic increasing ISO timestamp, `seconds` after the base.
export const ts = (seconds: number): string => new Date(BASE + seconds * 1000).toISOString();

export const userMsg = (
  sessionId: string,
  uuid: string,
  content: unknown,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: "user",
  uuid,
  parentUuid: null,
  sessionId,
  timestamp: ts(0),
  cwd: "/repo",
  gitBranch: "main",
  isSidechain: false,
  message: { role: "user", content },
  ...over,
});

export const assistantMsg = (
  sessionId: string,
  uuid: string,
  content: unknown,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: "assistant",
  uuid,
  parentUuid: null,
  sessionId,
  timestamp: ts(1),
  cwd: "/repo",
  gitBranch: "main",
  isSidechain: false,
  message: { role: "assistant", content },
  ...over,
});
