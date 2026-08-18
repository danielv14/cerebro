# cerebro

A permanent, searchable archive of every Claude Code session.

Claude Code forgets between sessions and deletes old session files over time.
cerebro copies every conversation into a local SQLite database and makes it
searchable. Each run picks up where the last one stopped, so indexing stays fast,
and conversations remain available even after Claude Code removes the originals.

## Install

```sh
bun install                                              # two small pure-JS deps (stopword, valibot) + types
ln -sf /path/to/cerebro/src/cli.ts ~/.local/bin/cerebro  # global `cerebro` on PATH
cerebro index                                            # build the archive
```

The CLI is a single Bun script, so a symlink from any directory on your PATH works
and always runs the current code. (`bun link` also works if your bun global bin dir
is on PATH.) Or run directly: `bun run src/cli.ts <command>`.

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
cerebro maintain                            # compact the search indexes and tidy the database
cerebro digest <action>                     # curated session summaries (see "Curated summaries")
```

`show` and `search` accept abbreviated session ids (the 8-char prefix shown in
listings); an ambiguous prefix errors. The reader commands (`search`, `sessions`,
`recent`, `relevant`, `show`, `stats`, `doctor`, `version`,
`digest stale|search|show`) take `--json` to print the results as JSON instead of
the human listing -- the stable format for scripts and agents.

### Database location

Default `~/.claude/cerebro/archive.sqlite`. Override with `--db <path>` or
`$CEREBRO_DB`. The scanned Claude directory (`~/.claude`) can be overridden with
`$CEREBRO_CLAUDE_DIR`.

Timestamps are stored in UTC and shown in local time, `Europe/Stockholm` by
default. Set `$CEREBRO_TZ` to any IANA zone name to change that
(`CEREBRO_TZ=UTC cerebro sessions`); an unknown zone falls back to the default
rather than erroring. The plain `TZ` variable is deliberately ignored: the hooks
and scheduled jobs inherit environments cerebro does not control, and letting
that silently change how the archive is displayed would be surprising.

The database lives outside this repo on purpose: it is generated, machine-local
data that grows large (tens of MB) and holds your private conversations word for
word. `*.sqlite` is gitignored regardless. Keeping it next to the Claude data it
indexes (the default) keeps the repo pure source.

### Backups

For sessions whose source files Claude Code has already deleted, the archive is
the only copy, so back it up. `cerebro backup` snapshots the database into a
single compact file at `<db-dir>/backups/archive-<timestamp>.sqlite`, using a
method (`VACUUM INTO`) that is safe to run while the database is being written
to. `--to <path>` picks an explicit target, and `--keep N` deletes the oldest
default-named backups beyond N. A natural place to hang it is the scheduled
digest batch, e.g. append `~/.claude/cerebro/cerebro backup --keep 8` to
`digest-stale-batch.sh`'s schedule or run it from the same launchd/cron entry.

To restore one, stop whatever writes to the archive first (disable the hook or
the launchd agent), then:

```sh
cp ~/.claude/cerebro/backups/archive-<timestamp>.sqlite ~/.claude/cerebro/archive.sqlite
rm -f ~/.claude/cerebro/archive.sqlite-wal ~/.claude/cerebro/archive.sqlite-shm
cerebro index      # catch up on everything written since the snapshot
cerebro doctor     # confirm integrity and schema before re-enabling the hook
```

Deleting the stale `-wal` / `-shm` files matters: they are SQLite working files
that belong to the replaced database, and SQLite would otherwise try to replay
them onto the snapshot.

`cerebro maintain` is the other housekeeping command: it compacts the search
indexes, refreshes SQLite's internal statistics, and trims the working files.
The scheduled digest batch runs it automatically at the end of each run.

### Health checks

`cerebro doctor` is one read-only report over everything that can quietly go
wrong: database and search-index integrity, the schema version, leftover index
state, sessions with no messages, oversized working files, summary coverage and
staleness, whether the deployed binary is out of date with the repo, and whether
the hook is wired in `settings.json` at all. It never repairs anything; each
finding names the command that does.

```sh
cerebro doctor            # quick integrity check, the everyday form
cerebro doctor --full     # the thorough integrity check (slower on a large archive)
cerebro doctor --json     # the same checks as structured rows
```

The exit code is 1 only on a hard failure (corruption, or a database schema this
build does not understand), so it works as a cron or CI guard without going red
on a warning like a summary backlog. `cerebro version` prints the build identity
on its own, which is what makes the out-of-date check possible: a binary built
from source reports itself as unbuilt rather than claiming a commit it does not
have.

## Automation

cerebro only runs when asked, so a Claude Code hook and a scheduled job are what
keep it current -- there is no background process. Those are operational details
rather than everyday usage, so they live in `docs/`:

- **[docs/hooks.md](docs/hooks.md)** - the `SessionEnd` hook that indexes and
  summarizes on `/clear`, and why it runs a deployed binary rather than the source.
- **[docs/scheduling.md](docs/scheduling.md)** - `digest-stale-batch.sh`, the
  catch-up script that works through the summary backlog, with a launchd plist
  and the cron equivalent.
- **[docs/digest-model-tiering.md](docs/digest-model-tiering.md)** - how the
  summary model is chosen by transcript size, the token budget behind the
  threshold, and the `CEREBRO_DIGEST_*` overrides.

The deployed binary is a frozen snapshot: a code change does not reach the
automated paths until `bun run deploy`. `cerebro doctor` reports when it is out
of date (see "Health checks").


## Curated summaries (`digest`)

On top of the word-for-word archive sits an optional layer of summaries: one
short, LLM-written summary per thread, stored in the same database and
searchable on its own. Summaries are dense and topical, so searching them
answers "what did I work on around X" far better than searching raw
transcripts, and they are cheap for a Claude session to read when relating past
work.

Summaries also make things faster. `relevant` only falls back to scanning raw
transcripts when the summaries come up short of `--limit`. That raw scan is the
expensive part: it touches one row per message, where the summary scan touches
one row per thread. Measured with the compiled binary against a synthetic archive
of 300 000 messages (1200 sessions, 148 MB) and no summaries at all, the worst
case where every lookup falls through to the raw scan:

```
cerebro relevant "<prose prompt>" --limit 5    386 ms
```

That is what a lookup costs on an archive with no summaries; it shrinks as more
threads get summarized.

cerebro owns the whole summarization step: the prompt, the choice of model by
transcript size, the storage format, and a guard that refuses to store output
that cannot be a real summary. It has no model of its own and never summarizes
on its own initiative: the model call is a single `claude` subprocess, and it
only happens when you ask for it:

```sh
cerebro digest stale [--limit N] [--ids]    # threads needing a (re)summary (never summarized,
                                            #   new activity since, or older prompt version).
                                            #   --ids: one full id per line, for scripts
cerebro digest run <id>                     # summarize one thread: render, pick the model,
                                            #   call it, check the output, store it
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

It spawns `claude -p --no-session-persistence` with the model the size tiering
picked, hands it the transcript on stdin, and stores the result only if the
call succeeded and the output looks like an actual summary rather than an error
message or a fragment. Nothing is stored on failure, so the thread stays stale
and the next `drain` retries it. `CEREBRO_CLAUDE_BIN` overrides which binary is
spawned.

The individual steps are still there when you want to drive them yourself, or
summarize inline as an agent without spawning anything:

```sh
cerebro digest input <id> | claude -p "$(cerebro digest prompt)" | cerebro digest write <id>
```

Pipe `digest input` rather than `show --full`: it renders the same transcript
but trimmed to fit a single model context, so a giant thread does not overflow
it. Either route keeps the contract in one place: the prompt asks for exactly
what `digest write` stores, and `digest stale` re-surfaces a thread whenever it
gains messages or the prompt version (`DIGEST_PROMPT_VERSION`) is bumped.
`digest drain` is the catch-up command, run "now and then" or on a schedule;
the summary fired on `/clear` is an optional fast path on top of it, never the
source of truth.

## How it works

- **Incremental, and safe to re-run.** cerebro remembers how far into each file
  it has read, so a run only reads what was appended since last time; unchanged
  files are skipped entirely. Plain `cerebro index` is the everyday command.
  `--full` re-reads everything (duplicate detection makes that safe) and is only
  for a suspected-corrupt read position; because known messages are skipped, it
  never touches stored text. `--rebuild` is the one that does: it re-reads
  everything *and* rewrites the stored text of every message whose source is
  still on disk (use it after a parser change). Messages whose source file
  Claude Code already deleted are never touched by either mode: the archive is
  their only copy. `--dry-run` reports what would be indexed without writing.
- **Duplicates are impossible by design.** Every message carries a stable
  unique id, and that id is the archive's key. Reopening and re-indexing a
  session appends to the existing thread instead of duplicating it.
- **Deleted sessions stay searchable.** A session remains in the archive after
  Claude Code deletes its source file; only the ability to re-read the original
  is gone.
- **Threads survive resumes.** When a session is resumed, its first message
  points back at a message from the earlier session; following those links
  joins the pieces into one logical thread. `sessions` lists threads; resumes
  fold in. A session opened and closed without a single exchange is not a
  thread: it is hidden from `sessions`, `recent`, and the `stats` counts, but
  `show <id>` on it still works.
- **Subagents fold into the parent.** Transcripts under
  `<session>/subagents/agent-*.jsonl` are attributed to their parent session, so
  their turns appear inline in `show`, tagged `[subagent]`.
- **Tool output is capped.** Prose and reasoning are kept in full, but each
  tool call and tool result is truncated to its first 1 KB (plus a
  `[+N chars truncated]` marker). The first kilobyte holds the searchable part
  (tool name, file path, command, the lines a reply refers to); the dropped
  bulk is reproducible state that ages poorly and pollutes search. Errors are
  kept in full.
- **Search results stay small.** `search` returns id + timestamp + project +
  snippet; the full text is fetched on demand via `show`, so results do not
  flood an agent's context window.

### How search matches words

Search matches whole words, with accents folded away. That is a deliberate
choice for a mixed Swedish/English archive, with known trade-offs:

- **Accents fold**: `för` matches `for`, and `å/ä/ö` match `a/o`. Good for
  recall (queries typed without the accents still hit), a slight precision
  loss.
- **No stemming**: `sessioner` does not match `session`, and English plurals
  miss too. The available stemmer would fix English but mangle Swedish, and
  substring matching would roughly triple the index size. Neither trade is
  clearly worth it, so whole-word matching stands; `relevant` softens the
  impact for prose prompts by searching every word of the prompt at once.

(For the technically curious: the FTS5 tables use the default `unicode61`
tokenizer with `remove_diacritics 1`.) Changing this later means recreating the
search indexes and re-running `cerebro index --rebuild`, so revisit it only
with a concrete missed-match problem in hand.

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
                + the ambient clock/cwd + rendering (a command returns data;
                runCli prints it)
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
  digest/       DIGEST_PROMPT + model tiering (prompt.ts), staleThreads() +
                summaryCoverage() (stale.ts), writeSummary() + searchSummaries()
                (store.ts), the summarize pipeline + the Summarizer seam (run.ts)
  digest-signature.ts  the prompt's opening sentence (leaf; the indexer keys
                digest-transcript skipping on it)
  backup.ts     runBackup() (VACUUM INTO snapshots + pruning)
test/
  *.test.ts     bun test suite + fixtures.ts (temp claude dir + sessions);
                per-command formatting tests under test/commands/
```

Built on Bun (`bun:sqlite`, synchronous, no native or network deps). Two small
pure-JS dependencies: `stopword` filters filler words out of relevance queries,
and `valibot` validates the untrusted input boundaries (the session JSONL and
the two hook stdin payloads). Ranked search comes from SQLite FTS5 full-text
indexes over the messages and summaries.
