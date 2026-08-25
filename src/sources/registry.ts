import type { SessionFile, SourceAdapter } from "./adapter.ts";
import { claudeCodeAdapter } from "./claude-code.ts";

// The registry of sources cerebro indexes. Adding a source is: implement its
// SourceAdapter in a sibling file (see docs/source-adapters.md for the contract)
// and add it to this list. Claude Code is the only adapter today.
export const sourceAdapters = (): SourceAdapter[] => [claudeCodeAdapter];

// Resolve the adapter a discovered file came from. An unknown provider is a
// programming error (files only enter the pipeline through an adapter's own
// discover), so this throws rather than guessing a classifier.
export const adapterFor = (
  provider: string,
  adapters: SourceAdapter[] = sourceAdapters(),
): SourceAdapter => {
  const adapter = adapters.find((a) => a.id === provider);
  if (!adapter) throw new Error(`no source adapter registered for provider "${provider}"`);
  return adapter;
};

// Every session file across all sources, sorted oldest-first by mtime (tiebreak
// sessionId). Oldest-first matters (invariant #3): an original session must be
// indexed before any resume that branches from it, so a shared message is
// attributed to the original, not the resume. The sort is global, here, so no
// adapter has to order its own files and cross-source order is deterministic.
export const discoverAllSessionFiles = (
  adapters: SourceAdapter[] = sourceAdapters(),
): SessionFile[] => {
  const out = adapters.flatMap((adapter) => adapter.discover());
  out.sort(
    (a, b) =>
      a.mtimeMs - b.mtimeMs || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
  );
  return out;
};
