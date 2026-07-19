# cerebro

Permanent verbatim archive + full-text search over every Claude Code session.

Claude Code forgets between sessions and deletes old session files over time.
cerebro on-demand indexes all session JSONL into a local SQLite database,
incrementally from where it last stopped, and keeps conversations searchable even
after Claude Code removes the originals.

## Install

```sh
bun install                                              # two small pure-JS deps (stopword, valibot) + types
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
cerebro index [--full] [--rebuild] [--dry-run]   # incremental index (--full re-reads all; --rebuild also re-flattens stored text; --dry-run writes nothing)
cerebro search <query> [--limit N] [--project P] [--since D] [--all]
                                            # ranked full-text search, snippet-first
                                            #   (best hit per thread; --all for every message)
cerebro sessions [--project P] [--limit N]  # list threads, newest activity first
cerebro recent [--cwd P] [--days D]         # recent threads for one repo
cerebro relevant <prompt> [--limit N]       # past threads relevant to a prompt
cerebro show <session-id> [--full] [--range A..B]  # outline (default), full transcript, or a slice
cerebro stats                               # archive counts
cerebro backup [--to <path>] [--keep N]     # snapshot the database (see "Backups")
cerebro maintain                            # optimize FTS indexes, refresh planner stats, truncate WAL
cerebro digest <action>                     # curated session summaries (see "Curated summaries")
```

`show` and search accept abbreviated session ids (the 8-char prefix shown in
listings); an ambiguous prefix errors. The reader commands (`search`, `sessions`,
`recent`, `relevant`, `show`, `stats`, `digest stale|search|show`) take `--json`
to emit the rows as JSON instead of the human listing -- the stable contract for
scripts and agents.

### Database location

Default `~/.claude/cerebro/archive.sqlite`. Override with `--db <path>` or
`$CEREBRO_DB`. The scanned Claude directory (`~/.claude`) can be overridden with
`$CEREBRO_CLAUDE_DIR`.

The database lives outside this repo on purpose: it is derived, machine-local data
that grows large (tens of MB) and holds verbatim private conversations. `*.sqlite`
is gitignored regardless. Keeping it next to the Claude data it indexes (the
default) keeps the repo pure source.

### Backups

For sessions whose source files Claude Code has already deleted, the archive is the
only copy, so back it up. `cerebro backup` snapshots the database with `VACUUM INTO`
(safe against a concurrently-writing WAL database, produces a compact standalone
file) into `<db-dir>/backups/archive-<timestamp>.sqlite`; `--to <path>` picks an
explicit target, and `--keep N` prunes the oldest default-named backups beyond N.
A natural place to hang it is the scheduled digest batch, e.g. append
`~/.claude/cerebro/cerebro backup --keep 8` to `digest-stale-batch.sh`'s schedule
or run it from the same launchd/cron entry.

`cerebro maintain` is the other housekeeping entry point: it merges the FTS
indexes' incremental b-trees (`optimize`), refreshes the query planner's stats
(`PRAGMA optimize`), and truncates the WAL. The scheduled digest batch runs it
automatically at the end of each run.

## Hooks (auto-index + context injection)

cerebro is on-demand, so two Claude Code hooks keep it useful without a daemon: one
re-indexes when you clear a session, the other surfaces relevant past threads on each
prompt. (Claude Code deletes session files after `cleanupPeriodDays`, default 30;
raise it in `~/.claude/settings.json` and index before then.)

Deploy a standalone binary so the hooks start fast (no `bun` spawn per event) and run
even where `bun` is not on `PATH`:

```sh
bun run deploy   # builds dist/cerebro, copies it + the hook scripts (summarize-on-clear.sh, digest-stale-batch.sh) into $CLAUDE_CONFIG_DIR/cerebro (default ~/.claude/cerebro)
```

The binary is a frozen snapshot of the source. The PATH symlink (`~/.local/bin/cerebro`)
tracks the repo live, but the hooks run this compiled copy, so a code
change (or a digest-prompt change) does not reach the automated path until you re-run
`bun run deploy`.

### Index + summarize on /clear

A `SessionEnd` hook with `matcher: "clear"` runs `summarize-on-clear.sh` the moment you
clear a session. It indexes synchronously (so the just-finished session is captured
immediately) and then fires a detached `claude -p` summary of that session in the
background, so `/clear` is never blocked by the LLM call. In `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      { "matcher": "clear", "hooks": [ { "type": "command", "command": "~/.claude/cerebro/summarize-on-clear.sh", "timeout": 120 } ] }
    ]
  }
}
```

`cerebro index` is incremental, so it only reads changed files; anything not yet flushed
is caught by the next index. The background summary is best-effort: if it dies (no auth,
rate limit, killed on teardown), `cerebro digest stale` re-surfaces the thread. To index
on /clear without auto-summarizing, point the hook at `~/.claude/cerebro/cerebro index`
instead.

The detached summary runs `claude -p --no-session-persistence`, so the summarization
call itself never writes a transcript into `~/.claude/projects` for the indexer to pick
up as a bogus session. As a backstop the indexer also skips any transcript whose first
turn is the digest prompt, so even a digest run that predates this (or one written some
other way) never enters the archive.

The summary model is tiered by transcript size, since the model context window is the
real constraint. Small threads (the common case) use `claude-haiku-4-5` (mechanical
compress-and-tag work, cheapest input price, no effort/thinking overhead). Oversized
threads escalate to `claude-sonnet-4-6[1m]` in a single shot: Sonnet has a 1M-token
context at a flat $3/$15 per MTok (no long-context premium), so a 400-600k-token thread
is summarized whole rather than truncated or map-reduced. The `[1m]` suffix is required:
it is how Claude Code selects the 1M-context variant; plain `claude-sonnet-4-6` gets the
default 200k window and a giant thread still fails with "Prompt is too long". cerebro
owns the tiering: the hook asks `cerebro digest model` (passing `--bytes <n>`, the size of
the `digest input` it already rendered, so the transcript is not rendered twice; `digest
model <id>` renders and measures for manual use), which decides by the rendered
transcript's byte size (`cerebro digest input` is the size-bounded transcript; see the
`digest` section), and `cerebro digest input` water-fill-caps anything large enough to
risk overflowing even a 1M context. The threshold is derived from a token budget, not the
raw window: `claude -p` prepends its own system prompt and tool definitions (~77k tokens
measured), so the default reserves 90k tokens of the small model's 200k window and treats
the rest (≈330k bytes at 3 bytes/token) as the transcript budget. Override the tier via
`CEREBRO_DIGEST_MODEL` (small, default Haiku), `CEREBRO_DIGEST_MODEL_LARGE` (large, default
`claude-sonnet-4-6[1m]`), and `CEREBRO_DIGEST_HAIKU_MAX_CHARS` (escalation threshold,
default 330000) in the hook's environment.

### Drain the backlog (scheduled reconciler)

The `/clear` hook only summarizes the one session you just cleared, so every session
that ends another way (headless `claude -p`, abandoned, still open) never gets a summary
on its own. `digest-stale-batch.sh` is the reconciler that closes that gap: it indexes,
then summarizes up to `CEREBRO_DIGEST_BATCH_CAP` (default 8) stale threads per run,
newest first, reusing the same `claude -p` pipeline and size tiering as the `/clear`
hook. A `mkdir` lock keeps two runs from overlapping, and failures are left for the next
run. Cap the per-run count so a large backlog drains over several runs instead of one
token burst; raise the cap (or run it by hand) to drain faster:

```sh
CEREBRO_DIGEST_BATCH_CAP=400 ~/.claude/cerebro/digest-stale-batch.sh   # one-shot full drain
```

Schedule it however you like. On macOS, a `launchd` agent every 6 hours keeps the
backlog near zero. The plist is machine-specific (absolute paths; launchd does not
expand `~` or `$HOME`), so it is not checked in; create
`~/Library/LaunchAgents/com.<you>.cerebro.digest-stale.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.you.cerebro.digest-stale</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/YOU/.claude/cerebro/digest-stale-batch.sh</string>
  </array>
  <!-- Fixed clock times, not StartInterval: on a laptop that sleeps, StartInterval
       coalesces missed runs into one burst on wake. -->
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>0</integer><key>Minute</key><integer>17</integer></dict>
    <dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>17</integer></dict>
    <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>17</integer></dict>
    <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>17</integer></dict>
  </array>
  <!-- launchd starts with a bare environment; claude and cerebro are native binaries
       but still need a sane PATH. -->
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/Users/YOU/.local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>StandardOutPath</key><string>/Users/YOU/.claude/cerebro/digest-stale.launchd.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/.claude/cerebro/digest-stale.launchd.log</string>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.you.cerebro.digest-stale.plist   # load
launchctl kickstart -k gui/$(id -u)/com.you.cerebro.digest-stale                              # run now
launchctl bootout   gui/$(id -u) ~/Library/LaunchAgents/com.you.cerebro.digest-stale.plist   # unload
```

Progress lands in `digest.log` (lines prefixed `[stale ...]`). A plain `cron` entry that
runs the same script works just as well on Linux.

### Relevant past threads per prompt

`cerebro recent` lists recent threads for a repo and `cerebro relevant <prompt>`
returns the threads most relevant to a prompt (FTS, bm25, recency-decayed: within
each tier the bm25 score decays with the thread's age at a 90-day half-life, so an
equal text match prefers recent work; plain `search` stays pure bm25). `relevant`
matches the curated summaries first (high signal) and falls back to raw-transcript
bm25 for threads not yet summarized; a snippet labelled `summary:` came from the summary,
`match:` from the transcript. Both surface compact, recognizable breadcrumbs (id,
date, title, the opening prompt, and for `relevant` a matching snippet), index-first
so the model pulls detail on demand with `show` / `search`. `--context` emits an
agent-facing block (silent when nothing matches); `--stdin` reads the prompt from a
hook's JSON payload.

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

## Curated summaries (`digest`)

On top of the verbatim archive sits an optional curated layer: one LLM-written
summary per thread, stored in a `summaries` table (same database) with its own FTS
index. Summaries are dense and topical, so searching them surfaces "what did I work
on around X" far better than raw-transcript bm25, and they are cheap for a Claude
session to read when relating past work.

cerebro stays pure storage and **never calls an LLM**. It owns the prompt and the
storage format (one versioned contract), and accepts a summary the model produced:

```sh
cerebro digest stale [--limit N] [--ids]    # threads needing a (re)summary (never summarized,
                                            #   new activity since, or older prompt version).
                                            #   --ids: one full id per line, for scripts
cerebro digest prompt                       # print the canonical summarization prompt
cerebro digest input <id>                   # print the size-bounded transcript to summarize
cerebro digest model <id> | --bytes N       # print the model the size tiering would pick
                                            #   (--bytes: tier an already-measured size
                                            #    without re-rendering the transcript)
cerebro digest write <id> [--model M]       # store a summary for a thread (read from stdin;
                                            #   rejects error-looking or too-short input with
                                            #   exit 1 so the thread stays stale and is retried)
cerebro digest search <query> [--limit N]   # full-text search the summaries
cerebro digest show <id>                    # print a thread's stored summary
```

The model step lives outside the binary, in a hook or skill that pipes a transcript
through `claude -p` and writes the result back. Pipe `digest input` (not `show --full`):
it renders the same transcript but bounded to fit a single model context, so a giant
thread does not blow the context limit.

```sh
cerebro digest input <id> | claude -p "$(cerebro digest prompt)" | cerebro digest write <id>
```

This keeps the contract in one place: the prompt asks for exactly what `digest write`
stores, and `digest stale` re-surfaces a thread whenever it gains messages or the
prompt version (`DIGEST_PROMPT_VERSION`) is bumped. Run `digest stale` as a batch
"now and then" (it is the reconciler); a fire-and-forget summary on `/clear` is an
optional fast path on top, never the source of truth.

## How it works

- **Incremental + idempotent.** A per-file byte cursor (`index_state`) means each
  run reads only newly appended bytes; unchanged files are skipped entirely. Plain
  `cerebro index` is the everyday command. `--full` re-reads everything (dedup makes
  it safe) and is only for a suspected-corrupt cursor state; because dedup skips
  known messages, it never touches stored text. `--rebuild` is the one that does:
  it re-reads everything *and* re-flattens the stored text of every message whose
  source is still on disk (use it after a `flattenContent`/parser change). Messages
  whose source file Claude Code already deleted are never touched by either mode:
  the archive is their only copy. `--dry-run` reports what would be indexed without
  writing.
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

### Search tokenization

The FTS tables use FTS5's default `unicode61` tokenizer with its default
`remove_diacritics 1`. That is a deliberate choice for a mixed Swedish/English
archive, with known trade-offs:

- **Diacritics fold**: `för` matches `for`, and `å/ä/ö` fold to `a/o`. Good for
  recall (queries typed without diacritics still hit), a slight precision loss.
- **No stemming**: `sessioner` does not match `session`, English plurals miss
  too. The `porter` stemmer would fix English but mangle Swedish; a `trigram`
  tokenizer would give substring matching at roughly 3x the index size. Neither
  trade is clearly worth it, so exact-token matching stands; `relevant`'s
  OR-of-tokens queries soften the impact for prose prompts.

Changing the tokenizer later means recreating the FTS tables and re-running
`cerebro index --rebuild`, so revisit this only with a concrete recall problem
in hand.

## Tests

```sh
bun test
```

The suite under `test/` runs against an in-memory SQLite DB plus temp fixture
session files (`CEREBRO_CLAUDE_DIR`), never the real archive. It covers the
critical paths: byte/cursor splitting and partial-line handling, dedup +
incremental indexing, truncation reset, subagent folding, thread relinking,
session-file discovery (ordering, tiebreak, the subagent walk), git resolution
(repo root + remote, missing-dir tolerance), dry-run parity, every query function,
and the digest layer (staleness detection, upsert + FTS sync, root attribution,
summary search).

## Lint and format

[Biome](https://biomejs.dev) handles both linting and formatting (config in
`biome.json`):

```sh
bun run check       # lint + format check, read-only (the same biome ci runs in CI)
bun run check:fix   # apply lint fixes + formatting
bun run format      # format only, write
bun run lint        # lint only
```

CI runs `biome ci` on every PR alongside typecheck, tests, and a compile build.

## Layout

```
src/
  cli.ts        parseArgs + the command dispatch table + db lifetime
  help.ts       the HELP text
  commands/     one module per command (handler + its output formatting)
    context.ts  CliIO / CliValues / CommandContext seam + resolveOrFail
  db.ts         openDb() + schema/migrations
  paths.ts      session-file discovery (top-level + subagents)
  jsonl.ts      parseLine() + classify() + flattenContent()
  git.ts        gitInfo(cwd) with cache
  indexer.ts    runIndex(), dryRunIndex(), eachIndexableFile(), relinkThreads()
  thread.ts     rootOf(), threadMessages(), threadOpeningPrompt(), threadLastTs()
  query.ts      search(), listThreads(), recentThreads(), relevantThreads(), ...
  render.ts     shared formatting primitives (shortId, shortTime, oneLine, ...)
  digest/       DIGEST_PROMPT + model tiering (prompt.ts), staleThreads()
                (stale.ts), writeSummary() + searchSummaries() (store.ts)
  digest-signature.ts  the prompt's opening sentence (leaf; the indexer keys
                digest-transcript skipping on it)
  backup.ts     runBackup() (VACUUM INTO snapshots + pruning)
test/
  *.test.ts     bun test suite + fixtures.ts (temp claude dir + sessions);
                per-command formatting tests under test/commands/
```

Built on Bun (`bun:sqlite`, synchronous, no native or network deps). Two small
pure-JS dependencies: `stopword` filters filler words out of relevance queries, and
`valibot` validates the untrusted I/O boundaries (the session JSONL and the hook
stdin payload). FTS5 external-content tables over `messages` and `summaries` provide
ranked search.
