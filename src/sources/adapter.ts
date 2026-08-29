// The source-adapter contract. Guarantees and how-to: docs/source-adapters.md.

export interface SessionFile {
  path: string;
  // "subagent" folds into the parent session named by sessionId.
  kind: "session" | "subagent";
  // The session every message in this file is attributed to (invariant #6).
  sessionId: string;
  // Per-source grouping directory; repo/project scoping runs off `cwd`, never
  // off this.
  projectDir?: string;
  provider: string;
  size: number;
  mtimeMs: number;
}

export type Classified =
  | {
      kind: "message";
      uuid: string;
      parentUuid: string | null;
      sessionId: string | null;
      role: "user" | "assistant";
      text: string;
      ts: string | null;
      cwd: string | null;
      gitBranch: string | null;
      isSidechain: boolean;
      model: string | null;
    }
  | { kind: "title"; sessionId: string | null; title: string; priority: number }
  | { kind: "skip" };

export interface SourceAdapter {
  // Never rename an id once sessions carry it: the migration backfill only heals
  // a NULL provider, so a rename orphans every row stamped with the old id.
  // test/sources.test.ts pins the registered ids.
  id: string;
  // A missing or unreadable root returns [] rather than throwing.
  discover: () => SessionFile[];
  classifyLines: (lines: string[]) => Generator<Classified>;
}

// `undefined` (never a valid JSON value) on parse failure, so a malformed line is
// distinguishable from one that parses to a falsy value like 0 or null.
export const parseLine = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};
