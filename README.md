# cerebro

Permanent verbatim archive + full-text search over every Claude Code session.

Claude Code forgets between sessions and deletes old session files over time.
cerebro on-demand indexes all session JSONL into a local SQLite database,
incrementally from where it last stopped, and keeps conversations searchable even
after Claude Code removes the originals.

## Install

```sh
bun install                                              # one small pure-JS dep (stopword) + types
ln -sf /path/to/cerebro/src/cli.ts ~/.local/bin/cerebro  # global `cerebro` on PATH
cerebro index                                            # build the archive
```

The CLI is `src/cli.ts` with a `#!/usr/bin/env bun` shebang, so a symlink from any
PATH directory works and tracks the repo live. (`bun link` also works if your bun
global bin dir is on PATH.) Or run directly: `bun run src/cli.ts <command>`.

### Skill

`skills/cerebro/SKILL.md` documents the CLI for Claude Code. Symlink it in:

```sh
ln -sf /path/to/cerebro/skills/cerebro ~/.claude/skills/cerebro
```

## Usage

```sh
cerebro index [--full] [--dry-run]          # incremental index (--full re-reads all; --dry-run writes nothing)
cerebro search <query> [--limit N]          # ranked full-text search, snippet-first
cerebro sessions [--project P] [--limit N]  # list threads, newest activity first
cerebro recent [--cwd P] [--days D]         # recent threads for one repo
cerebro relevant <prompt> [--limit N]       # past threads relevant to a prompt
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

## Hooks (auto-index + context injection)

cerebro is on-demand, so two Claude Code hooks keep it useful without a daemon: one
re-indexes when you clear a session, the other surfaces relevant past threads on each
prompt. (Claude Code deletes session files after `cleanupPeriodDays`, default 30;
raise it in `~/.claude/settings.json` and index before then.)

Build a standalone binary first so the hooks start fast (no `bun` spawn per event):

```sh
bun run build                          # -> dist/cerebro (standalone)
mkdir -p ~/.claude/cerebro
cp dist/cerebro ~/.claude/cerebro/cerebro
```

The binary is a snapshot of the source; rebuild and copy again after changing the code.

### Index on /clear

A `SessionEnd` hook with `matcher: "clear"` runs `cerebro index` the moment you clear
a session, so a just-finished session is captured immediately instead of waiting for
the next run. In `~/.claude/settings.json` (the hook runs in a shell, so `~` expands;
use the absolute binary path if unsure):

```json
{
  "hooks": {
    "SessionEnd": [
      { "matcher": "clear", "hooks": [ { "type": "command", "command": "~/.claude/cerebro/cerebro index", "timeout": 120 } ] }
    ]
  }
}
```

`cerebro index` is incremental, so it only reads changed files. Anything not yet
flushed to disk is caught by the next index regardless, since mid-write lines are
deferred safely.

### Relevant past threads per prompt

`cerebro recent` lists recent threads for a repo and `cerebro relevant <prompt>`
returns the threads most relevant to a prompt (FTS, bm25). Both surface compact,
recognizable breadcrumbs (id, date, title, the opening prompt, and for `relevant` a
matching snippet), index-first so the model pulls detail on demand with `show` /
`search`. `--context` emits an agent-facing block (silent when nothing matches);
`--stdin` reads the prompt from a hook's JSON payload.

A `UserPromptSubmit` hook injects matching past threads on each prompt, so the model
picks up earlier work when your prompt overlaps it:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "~/.claude/cerebro/cerebro relevant --stdin --context --limit 5", "timeout": 15 } ] }
    ]
  }
}
```

It never blocks (always exits 0) and stays silent when nothing matches. Remove a hook
group to disable it.

## How it works

- **Incremental + idempotent.** A per-file byte cursor (`index_state`) means each
  run reads only newly appended bytes; unchanged files are skipped entirely. Plain
  `cerebro index` is the everyday command. `--full` (re-read everything, dedup makes
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
- **Tool blocks are capped.** Prose and reasoning are kept verbatim, but each
  `tool_use` / `tool_result` block is truncated to its first 1 KB (head kept, plus
  a `[+N chars truncated]` marker). The head holds the searchable part (tool name,
  file_path, command, the lines a reply refers to); the dropped bulk is reproducible
  state that ages poorly and pollutes search. Errors are kept in full.
- **Index-first retrieval.** `search` returns id + timestamp + project + snippet;
  full text is fetched on demand via `show`, keeping the context window small.

## Tests

```sh
bun test
```

The suite under `test/` runs against an in-memory SQLite DB plus temp fixture
session files (`CEREBRO_CLAUDE_DIR`), never the real archive. It covers the
critical paths: byte/cursor splitting and partial-line handling, dedup +
incremental indexing, truncation reset, subagent folding, thread relinking,
dry-run parity, and every query function.

## Layout

```
src/
  cli.ts       parseArgs + command dispatch + output
  db.ts        openDb() + schema/migrations
  paths.ts     session-file discovery (top-level + subagents)
  jsonl.ts     parseLine() + classify() + flattenContent()
  git.ts       gitInfo(cwd) with cache
  indexer.ts   runIndex(), dryRunIndex(), indexOneFile(), relinkThreads()
  query.ts     search(), listThreads(), recentThreads(), relevantThreads(), ...
test/
  *.test.ts    bun test suite + fixtures.ts (temp claude dir + sessions)
```

Built on Bun (`bun:sqlite`, synchronous, no native or network deps). One small
pure-JS dependency (`stopword`) filters filler words out of relevance queries.
FTS5 external-content table over `messages` provides ranked search.
