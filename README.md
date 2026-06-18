# cerebro

Permanent verbatim archive + full-text search over every Claude Code session.

Claude Code forgets between sessions and deletes old session files over time.
cerebro on-demand indexes all session JSONL into a local SQLite database,
incrementally from where it last stopped, and keeps conversations searchable even
after Claude Code removes the originals.

## Install

```sh
bun install                                          # one small pure-JS dep (stopword) + types
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

## Scheduling (daily auto-index, macOS)

The archive only captures what is on disk when `index` runs, and Claude Code deletes
session files after `cleanupPeriodDays` (default 30, raise it in `~/.claude/settings.json`).
Run `index` on a schedule so nothing is lost to that cleanup. On macOS, launchd does it.

Build a standalone binary first. Running the agent from a compiled binary (rather than
`bun src/cli.ts`) means the macOS background item is identified as `cerebro`, not as
Bun's code signer:

```sh
bun run build                                   # -> dist/cerebro (standalone)
mkdir -p ~/.claude/cerebro
cp dist/cerebro ~/.claude/cerebro/cerebro
codesign --force --sign - --identifier com.danielv.cerebro ~/.claude/cerebro/cerebro
```

Create `~/Library/LaunchAgents/com.danielv.cerebro.index.plist`. launchd does not
expand `~`, so use absolute paths (replace `/Users/you`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.danielv.cerebro.index</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/.claude/cerebro/cerebro</string>
    <string>index</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>/Users/you/.claude/cerebro/index.log</string>
  <key>StandardErrorPath</key><string>/Users/you/.claude/cerebro/index.log</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
```

Load it, and run once to verify (a sleeping Mac runs the missed job on wake):

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.danielv.cerebro.index.plist
launchctl kickstart -k gui/$(id -u)/com.danielv.cerebro.index
cat ~/.claude/cerebro/index.log
```

The agent runs a snapshot, not the live source. After changing the code, rebuild and
reinstall the binary:

```sh
bun run build && cp dist/cerebro ~/.claude/cerebro/cerebro
codesign --force --sign - --identifier com.danielv.cerebro ~/.claude/cerebro/cerebro
```

Remove it: `launchctl bootout gui/$(id -u)/com.danielv.cerebro.index` and delete the plist.

## Context injection (recall past work)

Two commands surface past threads as compact, recognizable breadcrumbs (id, date,
title, the opening prompt, and for `relevant` a matching snippet), index-first so the
model pulls detail on demand with `show` / `search`:

- `cerebro recent [--cwd P] [--days D]` — recent threads for the current repo.
- `cerebro relevant <prompt>` — past threads most relevant to a prompt (FTS, bm25).
  `--stdin` reads the prompt from a hook's JSON payload instead of an argument.

Both accept `--context` to emit an agent-facing block (silent when nothing matches).

A `UserPromptSubmit` hook makes recall automatic: on each prompt it runs
`cerebro relevant --stdin --context` and injects matching past threads, so the model
picks up earlier work when your prompt overlaps it. In `~/.claude/settings.json`
(use the compiled binary from the Scheduling section so it starts fast per prompt):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "/Users/you/.claude/cerebro/cerebro relevant --stdin --context", "timeout": 15 } ] }
    ]
  }
}
```

It never blocks (always exits 0) and stays silent when nothing matches. Remove the
hook group to disable.

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
