// The source-adapter contract: the seam that decouples cerebro's archive from any
// one AI tool. A source is a program that writes append-only JSONL session logs
// (Claude Code today; Codex or another agent CLI tomorrow). Each source plugs in as
// a SourceAdapter that owns two things: discovering its session files on disk and
// normalizing its raw lines into the Classified events the indexer stores.
// Everything downstream of the adapter (the byte-cursor scan, the SQLite schema,
// FTS, search, relevance, digests) is source-agnostic and operates on the
// normalized shape only.
//
// What an adapter MUST guarantee, because the archive's invariants depend on it:
//
// - **Append-only JSONL files.** The scan layer keeps a byte cursor per file and
//   only ever reads new bytes past it (splitBuffer in scan.ts). A source that
//   rewrites earlier bytes in place cannot be indexed incrementally; the cursor
//   layer would silently miss the rewrites.
// - **A stable, globally unique id per message** (`Classified.uuid`). This is the
//   dedup key (invariant #4): re-reads, --full, and --rebuild are idempotent only
//   because the same message always carries the same id. A source without native
//   per-message ids must synthesize one that is stable across re-reads AND cannot
//   collide with another source's ids (prefix it with the provider id).
// - **An owning session id per file** (`SessionFile.sessionId`), the session every
//   message in that file is attributed to (invariant #6). Subagent/sidechain
//   transcripts must name the parent session so they fold into the parent thread;
//   a source without subagents simply never emits kind "subagent".
// - **Parent links are optional but must be honest.** `Classified.parentUuid`
//   feeds relinkThreads, which chains a resume's first message to the session
//   owning that uuid. A source without resume semantics returns null and its
//   sessions are all thread roots; a source must never fabricate links.
// - **Title events are optional.** A source that knows session titles emits
//   `kind: "title"` with the shared priority scale (user-set 3 > tool-generated
//   2 > derived summary 1); the indexer keeps the highest-priority title seen.
//
// Discovery order across all sources is handled by the registry (files are merged
// and sorted oldest-first by mtime, invariant #3), so discover() does not need to
// sort.

export interface SessionFile {
  path: string;
  // "session" = a top-level transcript; "subagent" = a nested sidechain transcript
  // whose messages fold into the parent session named by sessionId.
  kind: "session" | "subagent";
  // The session this file's messages belong to (see the attribution guarantee
  // above).
  sessionId: string;
  projectDir: string;
  // The id of the SourceAdapter that discovered this file. The indexer resolves
  // the classifier through it and stamps it on the session row as its provider.
  provider: string;
  size: number;
  mtimeMs: number;
}

// The normalized event shape every adapter classifies into. This is the whole
// vocabulary the indexer understands; anything a source's log carries beyond it is
// the adapter's job to fold in (into `text`) or drop (return `skip`).
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
      // The model that produced this turn, when the log records one (assistant
      // turns usually do, user turns do not). Harvested onto the session row.
      model: string | null;
    }
  | { kind: "title"; sessionId: string | null; title: string; priority: number }
  | { kind: "skip" };

export interface SourceAdapter {
  // Stable provider id, e.g. "claude-code". Stored on every session this adapter
  // discovers, so the archive always knows which tool a session came from. Never
  // rename an id once sessions carry it.
  id: string;
  // Walk the source's on-disk layout and return every session file it owns.
  // Order does not matter (the registry sorts globally); a missing or unreadable
  // root returns [] rather than throwing.
  discover: () => SessionFile[];
  // Normalize a batch of raw JSONL lines into classified events. Must be tolerant
  // of an evolving log: unknown event types classify to skip, missing optional
  // fields default to null, and a malformed line is skipped, never thrown on.
  classifyLines: (lines: string[]) => Generator<Classified>;
}

// Returns `undefined` (never a valid JSON value) on parse failure, so callers can
// distinguish a malformed line from a line that legitimately parses to a falsy
// value like 0, false, or null. Shared by the scan layer's mid-write tail check
// and any JSONL classifier.
export const parseLine = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};
