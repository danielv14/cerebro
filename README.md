# cerebro

Permanent verbatim archive + full-text search over every Claude Code session.

Claude Code forgets between sessions and deletes old session files over time.
cerebro on-demand indexes all session JSONL into a local SQLite database,
incrementally from where it last stopped, and keeps conversations searchable even
after Claude Code removes the originals.

## Install

```sh
bun install                                          # dev deps (types only; runtime needs none)
ln -sf ../../dev-personal/cerebro/src/cli.ts ~/.local/bin/cerebro   # global `cerebro` on PATH
cerebro index                                        # build the archive
```

The CLI is `src/cli.ts` with a `#!/usr/bin/env bun` shebang, so a symlink from any
PATH directory works and tracks the repo live. (`bun link` also works if your bun
global bin dir is on PATH.) Or run directly: `bun run src/cli.ts <command>`.

### Skill

`skills/cerebro/SKILL.md` documents the CLI for Claude Code. Symlink it in:

```sh
ln -sf ../../dev-personal/cerebro/skills/cerebro ~/.claude/skills/cerebro
```

## Usage

```sh
cerebro index [--full] [--dry-run]          # incremental index (--full re-reads all; --dry-run writes nothing)
cerebro search <query> [--limit N]          # ranked full-text search, snippet-first
cerebro sessions [--project P] [--limit N]  # list threads, newest activity first
cerebro show <session-id> [--full]          # outline (default) or full transcript
cerebro stats                               # archive counts
```

`show` and search accept abbreviated session ids (the 8-char prefix shown in
listings); an ambiguous prefix errors.

### Database location

Default `~/.claude/cerebro/archive.sqlite`. Override with `--db <path>` or
`$CEREBRO_DB`. The scanned Claude directory (`~/.claude`) can be overridden with
`$CEREBRO_CLAUDE_DIR`.

The database lives outside this repo on purpose: it is derived, machine-local data
that grows large (tens of MB) and holds verbatim private conversations. `*.sqlite`
is gitignored regardless. Keeping it next to the Claude data it indexes (the
default) keeps the repo pure source.

## How it works

- **Incremental + idempotent.** A per-file byte cursor (`index_state`) means each
  run reads only newly appended bytes; unchanged files are skipped entirely. Plain
  `cerebro index` is the daily command. `--full` (re-read everything, dedup makes
  it safe) is only for a suspected-corrupt index or a schema change. `--dry-run`
  reports what would be indexed without writing.
- **Dedup on message UUID.** The only stable key across resumes, so reopening and
  re-indexing a session appends to the existing thread instead of duplicating it.
- **Sidecar metadata survives deletion.** A session stays searchable in the
  archive after its `.jsonl` is gone (`body_available = 0`).
- **Threads across resumes.** A resume's first message points (via `parentUuid`)
  at a message owned by an earlier session; chaining those links rebuilds the
  logical thread root. `sessions` lists roots; resumes fold in.
- **Subagents fold into the parent.** Transcripts under
  `<session>/subagents/agent-*.jsonl` are attributed to their parent session, so
  sidechain turns appear inline in `show`, tagged `[subagent]`.
- **Index-first retrieval.** `search` returns id + timestamp + project + snippet;
  full text is fetched on demand via `show`, keeping the context window small.

## Layout

```
src/
  cli.ts       parseArgs + command dispatch + output
  db.ts        openDb() + schema/migrations
  paths.ts     session-file discovery (top-level + subagents)
  jsonl.ts     parseLine() + classify() + flattenContent()
  git.ts       gitInfo(cwd) with cache
  indexer.ts   runIndex(), dryRunIndex(), indexOneFile(), relinkThreads()
  query.ts     search(), listThreads(), threadMessages(), resolveSession()
```

Built on Bun (`bun:sqlite`, synchronous, no native deps). FTS5 external-content
table over `messages` provides ranked search.
