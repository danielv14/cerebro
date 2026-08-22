import type { Database } from "bun:sqlite";
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
  fs.writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
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
  fs.writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
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

// Count the ranked-hit queries a call issues, so a test can pin how many over-fetch
// rounds it ran. Wrapping db.query is the only seam for that: the window policy is
// internal to the FTS layer on purpose, and the round count is not in the result.
export const countHitQueries = (db: Database, run: () => void): number => {
  let queries = 0;
  const real = db.query.bind(db);
  db.query = ((sql: string) => {
    if (sql.includes("messages_fts MATCH")) queries++;
    return real(sql);
  }) as typeof db.query;
  try {
    run();
  } finally {
    db.query = real;
  }
  return queries;
};
