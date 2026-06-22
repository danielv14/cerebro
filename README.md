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
cerebro digest <action>                     # curated session summaries (see "Curated summaries")
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

Deploy a standalone binary so the hooks start fast (no `bun` spawn per event) and run
even where `bun` is not on `PATH`:

```sh
bun run deploy   # builds dist/cerebro, copies it + summarize-on-clear.sh into $CLAUDE_CONFIG_DIR/cerebro (default ~/.claude/cerebro)
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

The summary model is tiered by transcript size, since the model context window is the
real constraint. Small threads (the common case) use `claude-haiku-4-5` (mechanical
compress-and-tag work, cheapest input price, no effort/thinking overhead). Oversized
threads escalate to `claude-sonnet-4-6[1m]` in a single shot: Sonnet has a 1M-token
context at a flat $3/$15 per MTok (no long-context premium), so a 400-600k-token thread
is summarized whole rather than truncated or map-reduced. The `[1m]` suffix is required:
it is how Claude Code selects the 1M-context variant; plain `claude-sonnet-4-6` gets the
default 200k window and a giant thread still fails with "Prompt is too long". cerebro
owns the tiering: the hook asks `cerebro digest model <id>`, which decides by the rendered
transcript's byte size (`cerebro digest input` is the size-bounded transcript; see the
`digest` section), and `cerebro digest input` water-fill-caps anything large enough to
risk overflowing even a 1M context. Override the tier via `CEREBRO_DIGEST_MODEL` (small,
default Haiku), `CEREBRO_DIGEST_MODEL_LARGE` (large, default `claude-sonnet-4-6[1m]`),
and `CEREBRO_DIGEST_HAIKU_MAX_CHARS` (escalation threshold, default 540000) in the hook's
environment.

### Relevant past threads per prompt

`cerebro recent` lists recent threads for a repo and `cerebro relevant <prompt>`
returns the threads most relevant to a prompt (FTS, bm25). `relevant` matches the
curated summaries first (high signal) and falls back to raw-transcript bm25 for
threads not yet summarized; a snippet labelled `summary:` came from the summary,
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
cerebro digest stale [--limit N]            # threads needing a (re)summary (never summarized,
                                            #   new activity since, or older prompt version)
cerebro digest prompt                       # print the canonical summarization prompt
cerebro digest input <id>                   # print the size-bounded transcript to summarize
cerebro digest model <id>                   # print the model the size tiering would pick
cerebro digest write <id> [--model M]       # store a summary for a thread (read from stdin)
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
session-file discovery (ordering, tiebreak, the subagent walk), dry-run parity,
every query function, and the digest layer (staleness detection, upsert + FTS
sync, root attribution, summary search).

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
  digest.ts    DIGEST_PROMPT + staleThreads(), writeSummary(), searchSummaries(), ...
test/
  *.test.ts    bun test suite + fixtures.ts (temp claude dir + sessions)
```

Built on Bun (`bun:sqlite`, synchronous, no native or network deps). One small
pure-JS dependency (`stopword`) filters filler words out of relevance queries.
FTS5 external-content tables over `messages` and `summaries` provide ranked search.
