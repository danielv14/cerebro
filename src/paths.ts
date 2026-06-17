import { homedir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";

export interface SessionFile {
  path: string;
  // "session" = top-level <uuid>.jsonl; "subagent" = nested subagents/agent-*.jsonl
  kind: "session" | "subagent";
  // The session this file's messages belong to. For a subagent file that is the
  // parent session (the enclosing <uuid> directory), so its turns fold into the
  // parent thread.
  sessionId: string;
  projectDir: string;
  size: number;
  mtimeMs: number;
}

export const claudeDir = (): string =>
  process.env.CEREBRO_CLAUDE_DIR || join(homedir(), ".claude");

export const projectsDir = (): string => join(claudeDir(), "projects");

export const defaultDbPath = (): string =>
  process.env.CEREBRO_DB || join(claudeDir(), "cerebro", "archive.sqlite");

// Walk ~/.claude/projects/<project>/<session>.jsonl and return every session
// file, sorted oldest-first by mtime (tiebreak sessionId). Oldest-first matters:
// an original session must be indexed before any resume that branches from it,
// so a shared message is attributed to the original, not the resume.
export const discoverSessionFiles = (): SessionFile[] => {
  const root = projectsDir();
  let projectDirs: string[];
  try {
    projectDirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const out: SessionFile[] = [];

  const pushFile = (
    path: string,
    kind: SessionFile["kind"],
    sessionId: string,
    projectDir: string,
  ): void => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path);
    } catch {
      return;
    }
    if (!stat.isFile()) return;
    out.push({ path, kind, sessionId, projectDir, size: stat.size, mtimeMs: stat.mtimeMs });
  };

  for (const projectDir of projectDirs) {
    const dir = join(root, projectDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        // Top-level session file: filename (sans .jsonl) is the session UUID.
        const sessionId = entry.name.slice(0, -".jsonl".length);
        pushFile(join(dir, entry.name), "session", sessionId, projectDir);
      } else if (entry.isDirectory()) {
        // A per-session directory may hold subagent transcripts. The directory
        // name is the parent session UUID; fold the transcripts into it.
        const subDir = join(dir, entry.name, "subagents");
        let subEntries: string[];
        try {
          subEntries = fs.readdirSync(subDir);
        } catch {
          continue;
        }
        for (const name of subEntries) {
          if (!name.endsWith(".jsonl")) continue;
          pushFile(join(subDir, name), "subagent", entry.name, projectDir);
        }
      }
    }
  }

  out.sort(
    (a, b) =>
      a.mtimeMs - b.mtimeMs ||
      (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
  );
  return out;
};
