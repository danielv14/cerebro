import type { SessionFile, SourceAdapter } from "./adapter.ts";
import { claudeCodeAdapter } from "./claude-code.ts";

// Adding a source: docs/source-adapters.md.
export const sourceAdapters = (): SourceAdapter[] => [claudeCodeAdapter];

// An unknown provider is a programming error, so this throws rather than guessing.
export const adapterFor = (
  provider: string,
  adapters: SourceAdapter[] = sourceAdapters(),
): SourceAdapter => {
  const adapter = adapters.find((a) => a.id === provider);
  if (!adapter) throw new Error(`no source adapter registered for provider "${provider}"`);
  return adapter;
};

// Oldest-first by mtime, tiebreak sessionId (invariant #3: an original session
// must be indexed before any resume that branches from it).
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
