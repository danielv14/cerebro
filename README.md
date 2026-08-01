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
cerebro search <query> [--limit N] [--project P] [--branch B] [--since D] [--role R] [--prose] [--all]
                                            # ranked full-text search, snippet-first
                                            #   (best hit per thread; --all for every message)
                                            #   --role user|assistant, --prose: skip tool plumbing
cerebro sessions [--project P] [--branch B] [--since D] [--limit N]
                                            # list threads, newest activity first
cerebro recent [--cwd P] [--days D]         # recent threads for one repo
cerebro relevant <prompt> [--limit N] [--cwd P]   # past threads relevant to a prompt
                                            #   (threads in --cwd's repo rank higher)
cerebro show <session-id> [--full] [--range A..B]  # outline (default), full transcript, or a slice
cerebro stats                               # archive counts
cerebro doctor [--full]                     # read-only health report (see "Health checks")
cerebro version                             # build identity of this binary
cerebro backup [--to <path>] [--keep N]     # snapshot the database (see "Backups")
cerebro maintain                            # optimize FTS indexes, refresh planner stats, truncate WAL
cerebro digest <action>                     # curated session summaries (see "Curated summaries")
```

`show` and search accept abbreviated session ids (the 8-char prefix shown in
listings); an ambiguous prefix errors. The reader commands (`search`, `sessions`,
`recent`, `relevant`, `show`, `stats`, `doctor`, `version`,
`digest stale|search|show`) take `--json` to emit the rows as JSON instead of the
human listing -- the stable contract for scripts and agents.

### Database location

Default `~/.claude/cerebro/archive.sqlite`. Override with `--db <path>` or
`$CEREBRO_DB`. The scanned Claude directory (`~/.claude`) can be overridden with
`$CEREBRO_CLAUDE_DIR`.

Timestamps are stored verbatim UTC and displayed in wall-clock time, defaulting to
`Europe/Stockholm`. `$CEREBRO_TZ` takes any IANA zone (`CEREBRO_TZ=UTC cerebro
sessions`); an unknown zone falls back to the default rather than erroring. Bare `TZ`
is deliberately ignored: hooks and launchd inherit environments cerebro does not
control, and silently rendering the archive differently based on that would be
surprising.

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

To restore one, stop whatever writes to the archive first (disable the hooks or the
launchd agent), then:

```sh
cp ~/.claude/cerebro/backups/archive-<timestamp>.sqlite ~/.claude/cerebro/archive.sqlite
rm -f ~/.claude/cerebro/archive.sqlite-wal ~/.claude/cerebro/archive.sqlite-shm
cerebro index      # catch up on everything written since the snapshot
cerebro doctor     # confirm integrity and schema before re-enabling the hooks
```

Deleting the stale `-wal` / `-shm` files matters: they belong to the replaced
database and SQLite would otherwise try to recover them onto the snapshot.

`cerebro maintain` is the other housekeeping entry point: it merges the FTS
indexes' incremental b-trees (`optimize`), refreshes the query planner's stats
(`PRAGMA optimize`), and truncates the WAL. The scheduled digest batch runs it
automatically at the end of each run.

### Health checks

`cerebro doctor` is one read-only report over everything that can quietly go wrong:
SQLite and FTS integrity, the schema version, orphaned index cursors, zero-message
sessions, WAL size, digest coverage and staleness, whether the deployed binary has
drifted from the repo, and whether the hooks are wired in `settings.json` at all. It
never repairs anything; each finding names the command that does.

```sh
cerebro doctor            # quick_check integrity, the everyday form
cerebro doctor --full     # the complete integrity_check (slower on a large archive)
cerebro doctor --json     # the same checks as structured rows
```

Exit code is 1 only on a hard failure (corruption, or a schema this build cannot
speak), so it is usable as a cron or CI guard without going red on a warning like a
digest backlog. `cerebro version` prints the build identity on its own, which is what
makes the drift check possible: a binary built from source reports itself as unbuilt
rather than claiming a commit it does not have.

## Automation

cerebro is on-demand, so Claude Code hooks and a scheduled job are what keep it
current without a daemon. Those are operational details rather than everyday usage,
so they live in `docs/`:

- **[docs/hooks.md](docs/hooks.md)** - the `SessionEnd` hook that indexes and
  summarizes on `/clear`, the `UserPromptSubmit` hook that injects relevant past
  threads on each prompt, and why both run a deployed binary rather than the source.
- **[docs/scheduling.md](docs/scheduling.md)** - `digest-stale-batch.sh`, the
  reconciler that drains the summary backlog, with a launchd plist and the cron
  equivalent.
- **[docs/digest-model-tiering.md](docs/digest-model-tiering.md)** - how the summary
  model is chosen by transcript size, the token budget the threshold comes from, and
  the `CEREBRO_DIGEST_*` overrides.

The deployed binary is a frozen snapshot: a code change does not reach the automated
paths until `bun run deploy`. `cerebro doctor` reports when it has drifted (see
"Health checks").


## Curated summaries (`digest`)

On top of the verbatim archive sits an optional curated layer: one LLM-written
summary per thread, stored in a `summaries` table (same database) with its own FTS
index. Summaries are dense and topical, so searching them surfaces "what did I work
on around X" far better than raw-transcript bm25, and they are cheap for a Claude
session to read when relating past work.

Coverage buys latency too, not just recall. `relevant` only runs its raw-transcript
tier when the summary tier came up short of `--limit`, and the raw tier is one broad
OR-of-tokens scan over the message FTS index (one row per message) where the summary
tier scans one row per thread. So a summarized archive short-circuits the expensive
half of the code path that runs on **every prompt**. Measured with the compiled binary
against a synthetic archive of 300 000 messages (1200 sessions, 148 MB) and zero
summaries, the worst case where all traffic falls through to the raw tier:

```
cerebro relevant "<prose prompt>" --limit 5    386 ms
```

That is in front of the user on each prompt, and it shrinks as coverage rises.

cerebro owns the summarization contract end to end: the prompt, the size tiering, the
storage format (one versioned contract), and the guard that refuses to store output
that cannot be a summary. It has no model of its own and never summarizes on its own
initiative; the model call is one subprocess behind a seam, the same way git
resolution is, and it only happens when you ask for it:

```sh
cerebro digest stale [--limit N] [--ids]    # threads needing a (re)summary (never summarized,
                                            #   new activity since, or older prompt version).
                                            #   --ids: one full id per line, for scripts
cerebro digest run <id>                     # summarize one thread: render, tier the model,
                                            #   call it, guard the output, store it
cerebro digest drain [--limit N]            # do that for the N stalest threads, newest first
                                            #   (default 8); one failure never aborts the run
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

`digest run` is the whole sequence in one command, and it is what the hooks call:

```sh
cerebro digest run <id>              # one thread
cerebro digest drain --limit 8       # the stalest N, newest first
```

It spawns `claude -p --no-session-persistence` with the model the tiering picked,
hands it the transcript on stdin, and stores the result only if the call succeeded and
the output is not an error string or a fragment. Nothing is stored on failure, so the
thread stays stale and the next `drain` retries it. `CEREBRO_CLAUDE_BIN` overrides
which binary is spawned.

The composable verbs are still there when you want to drive the steps yourself, or
summarize inline as an agent without spawning anything:

```sh
cerebro digest input <id> | claude -p "$(cerebro digest prompt)" | cerebro digest write <id>
```

Pipe `digest input` rather than `show --full`: it renders the same transcript but
bounded to fit a single model context, so a giant thread does not blow the context
limit. Either route keeps the contract in one place: the prompt asks for exactly what
`digest write` stores, and `digest stale` re-surfaces a thread whenever it gains
messages or the prompt version (`DIGEST_PROMPT_VERSION`) is bumped. `digest drain` is
the reconciler, run "now and then" or on a schedule; a fire-and-forget summary on
`/clear` is an optional fast path on top, never the source of truth.

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
  logical thread root. `sessions` lists roots; resumes fold in. A thread with no
  indexed turns (a session opened and closed right away) is not a thread: the rollup
  hides it from `sessions`, `recent`, and the `stats` counts, while its metadata row
  stays, so `show <id>` on it still resolves.
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
  cli.ts        parseArgs + the dispatch table + option checking + db lifetime
                + rendering (a command returns data; runCli prints it)
  help.ts       the HELP text
  commands/     one module per command: its declared options, its run step, and
                its output formatting
    args.ts     options as data (flag/text/numeric/isoDate/choice/range) + CliError
    command.ts  defineCommand, CommandInput/CommandOutput, the group shape
    helpers.ts  readStdin() + resolveOrThrow()
  db.ts         openDb() + schema/migrations + dbFileSize()
  paths.ts      session-file discovery (top-level + subagents)
  jsonl.ts      parseLine() + classify() + flattenContent()
  git.ts        gitInfo(cwd) with cache
  indexer.ts    runIndex(), dryRunIndex(), eachIndexableFile(), relinkThreads()
  thread.ts     rootOf(), threadMessages(), threadOpeningPrompt(), threadLastTs()
  query.ts      search(), listThreads(), recentThreads(), relevantThreads(), ...
  render.ts     shared formatting primitives (shortId, shortTime, oneLine, ...)
  digest/       DIGEST_PROMPT + model tiering (prompt.ts), staleThreads()
                (stale.ts), writeSummary() + searchSummaries() (store.ts),
                the summarize pipeline + the Summarizer seam (run.ts)
  digest-signature.ts  the prompt's opening sentence (leaf; the indexer keys
                digest-transcript skipping on it)
  backup.ts     runBackup() (VACUUM INTO snapshots + pruning)
test/
  *.test.ts     bun test suite + fixtures.ts (temp claude dir + sessions);
                per-command formatting tests under test/commands/
```

Built on Bun (`bun:sqlite`, synchronous, no native or network deps). Two small
pure-JS dependencies: `stopword` filters filler words out of relevance queries, and
`valibot` validates the untrusted I/O boundaries (the session JSONL and the two hook
stdin payloads). FTS5 external-content tables over `messages` and `summaries` provide
ranked search.
