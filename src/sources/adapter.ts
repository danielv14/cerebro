// The source-adapter contract: the seam that decouples cerebro's archive from any
// one AI tool. The guarantees an adapter must give and the step-by-step for adding
// one live in docs/source-adapters.md; design notes in docs/architecture.md.

export interface SessionFile {
  path: string;
  // "subagent" = a nested sidechain transcript whose messages fold into the parent
  // session named by sessionId.
  kind: "session" | "subagent";
  // The session every message in this file is attributed to (invariant #6).
  sessionId: string;
  // The source's own grouping directory, if it has one (for Claude Code the
  // dash-encoded project name). Repo and project scoping run off `cwd`, never off
  // this.
  projectDir?: string;
  // The id of the SourceAdapter that discovered this file; stamped on the session
  // row as its provider.
  provider: string;
  size: number;
  mtimeMs: number;
}

// The whole event vocabulary the indexer understands; anything beyond it is the
// adapter's job to fold into `text` or drop (return `skip`).
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
      // Assistant turns usually record one, user turns do not.
      model: string | null;
    }
  | { kind: "title"; sessionId: string | null; title: string; priority: number }
  | { kind: "skip" };

export interface SourceAdapter {
  // Stable provider id, e.g. "claude-code". Never rename an id once sessions carry
  // it: the migration backfill only heals a NULL provider, so a rename orphans
  // every row stamped with the old id. test/sources.test.ts pins the registered ids.
  id: string;
  // Order does not matter (the registry sorts globally); a missing or unreadable
  // root returns [] rather than throwing.
  discover: () => SessionFile[];
  // Must be tolerant of an evolving log: unknown event types classify to skip,
  // missing optional fields default to null, a malformed line is skipped.
  classifyLines: (lines: string[]) => Generator<Classified>;
}

// Returns `undefined` (never a valid JSON value) on parse failure, so callers can
// distinguish a malformed line from a line that legitimately parses to a falsy
// value like 0, false, or null.
export const parseLine = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};
