# Source adapters

cerebro archives sessions through a source-adapter seam. Claude Code is one
adapter, not a hardwired assumption: each source owns its file discovery and the
normalization of its own log format, and everything downstream (the SQLite
archive, FTS search, threads, relevance, digests) is source-agnostic. This
document is the contract for writing a new adapter, e.g. for the Codex CLI or
another agent tool. It is written to be handed to an agent of that tool, which
can read its own real session logs while implementing.

## The seam

Three files under `src/sources/`:

- `adapter.ts` holds the contract: `SessionFile`, the normalized `Classified`
  event shape, and the `SourceAdapter` interface. Read its doc comments first;
  they state the guarantees below next to the types that carry them.
- `claude-code.ts` is the reference implementation's discovery half (the
  `~/.claude/projects` walk). Its normalization half is `src/jsonl.ts`.
- `registry.ts` holds the list of active adapters, the provider -> adapter
  lookup, and the global oldest-first merge of every source's files.

An adapter is two functions and an id:

```ts
export interface SourceAdapter {
  id: string; // stable provider id, stored on every session row
  discover: () => SessionFile[]; // walk the source's on-disk layout
  classifyLines: (lines: string[]) => Generator<Classified>; // normalize
}
```

The indexer drives everything else: it merges all adapters' files oldest-first,
keeps a byte cursor per file, reads only appended bytes, classifies them through
the owning adapter, and writes normalized rows. An adapter never touches the
database.

## The guarantees an adapter must give

These map onto the archive invariants in `CLAUDE.md`; breaking one silently
corrupts the archive.

1. **Append-only JSONL files.** The scan layer (`src/scan.ts`) advances a byte
   cursor per file and never re-reads old bytes on an incremental run. A source
   that rewrites earlier bytes in place cannot be indexed this way.
2. **A stable, globally unique message id** (`Classified.uuid`). This is the
   dedup key: re-reads and rebuilds are idempotent only because the same
   message always classifies to the same id. If the source has no native
   per-message ids, synthesize one that is (a) stable across re-reads and
   (b) collision-free against other sources. Prefix it with the provider id
   (`"codex:<...>"`). Do not derive it from anything that changes when the file
   is appended to.
3. **A provider id you never rename** (`SourceAdapter.id`). It is stamped on
   every session row the adapter discovers, and the schema migration's backfill
   only heals a NULL provider, not a stale one, so a rename orphans history
   instead of failing. The registered ids are pinned as literals in
   `test/sources.test.ts` ("pins the registered provider ids"); add your new id
   to that list, and a later rename turns into a red test.
4. **Honest attribution** (`SessionFile.sessionId`). Every message in a file is
   attributed to the file's owning session. Sidechain/subagent transcripts name
   the parent session and use `kind: "subagent"`; a source without subagents
   never emits that kind.
5. **Honest parent links** (`Classified.parentUuid`). Cross-session links are
   how resumes fold into one logical thread (`relinkThreads`). A source without
   resume semantics returns null everywhere and its sessions are all thread
   roots. Never fabricate links.
6. **Tolerant parsing.** An unknown event type classifies to `skip`, a missing
   optional field defaults to null, a malformed line is skipped. The log format
   will evolve under you; a parser that throws loses whole files. Fold whatever
   is searchable into `text` (see how `flattenContent` tags and caps tool
   output) and drop the rest.

Optional but wired through when present:

- **Titles**: emit `kind: "title"` with the shared priority scale (user-set 3 >
  tool-generated 2 > derived summary 1); the highest priority seen wins.
- **Model**: set `Classified.model` on turns that record one (assistant turns
  usually do). It is harvested onto the session row and surfaced as `model` in
  the JSON listings, alongside `provider`.
- **cwd / gitBranch**: fill them when the log records them; project and repo
  scoping (`recent`, `relevant`, `--project`) work through them.
- **projectDir** (`SessionFile.projectDir`): the source's own grouping directory
  for a session, if it has one. Claude Code passes the dash-encoded name under
  `~/.claude/projects`; a source that groups sessions differently, or not at
  all, omits the field and `sessions.project_dir` stays NULL. Nothing downstream
  reads it, so do not invent a value to fill it.

## Adding an adapter, step by step

1. Answer the four design questions against real logs of the source *before*
   coding: What is the dedup key? How do resumes/threads link, if at all? What
   is the owning session of each file (are there subagent files)? Are there
   title events? Write the answers into the adapter's header comment.
2. Implement `src/sources/<tool>.ts` exporting a `SourceAdapter`. Discovery
   must tolerate a missing root directory (return `[]`). Validate the untrusted
   log shape with Valibot, the same way `src/jsonl.ts` does; that is the
   project's I/O-boundary rule.
3. Register it in `src/sources/registry.ts`.
4. Test it. `test/sources.test.ts` already contains a complete fake adapter
   ("fake-agent") exercised end to end through `runIndex`. Use it as the
   template, then add the same coverage for the real adapter against fixture
   files copied from real logs: normalization, dedup idempotency (index twice,
   zero new), incremental append, provider + model on the session row, and FTS
   hits on the source's text. Add the id to the pinned provider list in the same
   file. `runIndex(db, { adapters })` and `dryRunIndex(db, full, adapters)` both
   take an injected adapter list, so tests never touch the registry or a real
   archive; index the same fixtures through both and assert the counts agree, so
   dry-run parity (invariant #2) holds for your source too.
5. Run `bun run typecheck`, `bun test`, `bun run check`, and update
   [layout.md](layout.md) plus this document's status line below.

What you do NOT need to touch: the schema, the indexer, the scan layer, search,
threads, or digests. If a new source seems to need a change there, stop and
reconsider the adapter design first.

## What stays Claude-specific on purpose

- The digest pipeline spawns the `claude` CLI to *write* summaries
  (`src/digest/run.ts`, behind the `Summarizer` seam). That choice is
  independent of which sources are indexed; a different summarizer backend is a
  new `Summarizer` adapter, not a source adapter.
- The hooks (`docs/hooks.md`) are Claude Code's hook system. A source without
  an equivalent trigger relies on the scheduled reconciler
  (`docs/scheduling.md`) to index and summarize its sessions.
- cerebro's own home stays `~/.claude/cerebro` (override with
  `CEREBRO_CLAUDE_DIR`/`CEREBRO_DB`) regardless of sources.

## Status

Registered adapters: `claude-code`. Sessions indexed before the seam existed
were backfilled with `provider = 'claude-code'` by a schema migration; their
`model` is NULL (the information was not captured then and is recovered on the
next `index --full`, whose re-read re-harvests it for files still on disk).
