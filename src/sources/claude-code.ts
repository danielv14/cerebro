import fs from "node:fs";
import { join } from "node:path";
import { classifyLines } from "../jsonl.ts";
import { claudeDir } from "../paths.ts";
import type { SessionFile, SourceAdapter } from "./adapter.ts";

// The Claude Code source: session transcripts under ~/.claude/projects. The JSONL
// event grammar this adapter normalizes lives in src/jsonl.ts; this file owns the
// on-disk layout (discovery and attribution).

export const CLAUDE_CODE_PROVIDER = "claude-code";

export const projectsDir = (): string => join(claudeDir(), "projects");

// Walk ~/.claude/projects/<project>/<session>.jsonl and return every session
// file. Top-level files own the session named by their filename UUID; a per-session
// <uuid>/subagents/ directory holds sidechain transcripts attributed to that parent
// session (invariant #6). Unsorted: the registry orders the merged set.
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
    out.push({
      path,
      kind,
      sessionId,
      projectDir,
      provider: CLAUDE_CODE_PROVIDER,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
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

  return out;
};

export const claudeCodeAdapter: SourceAdapter = {
  id: CLAUDE_CODE_PROVIDER,
  discover: discoverSessionFiles,
  classifyLines,
};
