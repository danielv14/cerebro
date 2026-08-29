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
                                            #   (a long outline shows the first and last 50
                                            #    messages with an omitted marker in between)
cerebro stats                               # archive counts
cerebro skills [--since D] [--limit N]      # how often each skill was invoked
cerebro doctor [--full]                     # read-only health report (docs/operations.md)
cerebro version                             # build identity of this binary
cerebro backup [--to <path>] [--keep N]     # snapshot the database (docs/operations.md)
cerebro maintain                            # compact the search indexes and tidy the database
cerebro digest <action>                     # curated session summaries (see "Curated summaries")
```

`show` and `search` accept abbreviated session ids (the 8-char prefix shown in
listings); an ambiguous prefix errors. The reader commands (`search`, `sessions`,
`recent`, `relevant`, `show`, `stats`, `skills`, `doctor`, `version`,
`digest stale|search|show`) take `--json` to print the results as JSON instead of
the human listing. That is the stable format for scripts and agents.

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

### Skill invocation counts

`cerebro skills` answers how often each skill was actually invoked, counted out
of the archive:

```
$ cerebro skills --limit 4
top 4 of 78 names, 2026-05-11 .. 2026-08-19 (built-in commands included; sub is the subagent part of total)
name                                slash  model  total    sub  last
clear                                 493      0    493      0  2026-08-19
commit                                 60     86    146      0  2026-08-19
exit                                  136      0    136      0  2026-08-18
changelog                              61      1     62      0  2026-08-18
```

A skill call leaves no field of its own in the session JSONL, so the count comes
from two markers in the turn text: `slash` is the expansion of a typed `/name` in
the user turn, `model` is a Skill tool call the model made. Both are needed;
counting one undercounts by a factor. `sub` is the part of `total` that came from
a subagent turn, since a subagent using a skill is using it.

The header says *names*, not skills, because the slash marker is Claude Code's
expansion of any `/name`: its own commands (`/clear`, `/model`) are in the list,
and a renamed skill appears under both names. Deciding which of those to merge or
ignore is the caller's business, not the archive's. There is no default limit,
because the question is usually which skills are *unused* and a trimmed tail
would turn a rarely called skill into a missing one. `--since D` narrows the
window; the window itself is printed, so "never called" stays distinguishable
from "called before the archive begins". Why the counting lives in cerebro at
all, and the rules it takes, is in
[docs/architecture.md](docs/architecture.md).

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
- **Sources are pluggable.** Claude Code is one source adapter, not a hardwired
  assumption: each source owns its file discovery and normalizes its own log
  format into the shared message shape, and everything downstream (the archive,
  search, threads, digests) is source-agnostic. Every session records which
  source it came from (`provider`) and the model its turns report (`model`);
  both ride along in every `--json` listing (`sessions`, `recent`, `relevant`,
  `search`, `digest search`), read from the thread rollup so the five agree.
  Adding a source (e.g. a Codex CLI adapter) is described in
  [docs/source-adapters.md](docs/source-adapters.md).
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

## Curated summaries (`digest`)

On top of the word-for-word archive, cerebro can store one short LLM-written
summary per thread. The summaries live in the same database and are searchable
on their own. They are dense and topical, so searching them answers "what did I
work on around X" far better than searching raw transcripts, they are cheap for
a Claude session to read when relating past work, and they make `relevant`
faster by keeping it off the raw scan.

cerebro owns the whole summarization step: the prompt, the choice of model by
transcript size, the storage format, and a guard that refuses to store output
that cannot be a real summary. It has no model of its own and never summarizes
on its own initiative. The model call is a single `claude` subprocess, and it
only happens when you ask for it.

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

`digest run` does the whole sequence in one command and is what the hooks call;
`digest drain` does it for the stalest N. [docs/digest.md](docs/digest.md) covers
the workflows: what summaries buy in lookup latency, how to drive the steps
yourself or summarize inline as an agent, and how coverage is kept up.

## Automation

cerebro has no background process; it only runs when asked. A Claude Code hook
and a scheduled job are what keep it current. Those are operational details
rather than everyday usage, so they live in `docs/`:

- [docs/hooks.md](docs/hooks.md) covers the `SessionEnd` hook that indexes and
  summarizes on `/clear`, and why it runs a deployed binary rather than the source.
- [docs/scheduling.md](docs/scheduling.md) covers `digest-stale-batch.sh`, the
  catch-up script that works through the summary backlog, with a launchd plist
  and the cron equivalent.
- [docs/digest-model-tiering.md](docs/digest-model-tiering.md) covers how
  transcript size picks the summary model, the token budget behind the
  threshold, and the `CEREBRO_DIGEST_*` overrides.

The deployed binary is a frozen snapshot: a code change does not reach the
automated paths until `bun run deploy`. `cerebro doctor` reports when it is out
of date.

## Operations

[docs/operations.md](docs/operations.md) covers backups, the restore procedure,
`cerebro maintain` and the `cerebro doctor` health report. The short version:
for sessions Claude Code has already deleted the archive is the only copy, so
run `cerebro backup --keep 8` on a schedule and `cerebro doctor` when something
looks off.

## Development

```sh
bun test            # the suite under test/
bun run typecheck   # tsc, must stay green
bun run check       # lint + format check, read-only (the same biome ci runs in CI)
bun run check:fix   # apply lint fixes + formatting
```

The suite runs against an in-memory SQLite database plus temp fixture session
files (`CEREBRO_CLAUDE_DIR`), never the real archive. CI runs `biome ci`,
typecheck, tests and a compile build on every PR.

`CLAUDE.md` has the working rules and the archive invariants,
[docs/layout.md](docs/layout.md) maps the source tree module by module, and
[docs/architecture.md](docs/architecture.md) explains how the modules fit
together and why. Built on Bun (`bun:sqlite`, synchronous) with two small
pure-JS dependencies and no native or network ones.
