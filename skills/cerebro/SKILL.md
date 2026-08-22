---
name: cerebro
description: Search and recall content from every past Claude Code session (verbatim archive with full-text search). Use on "cerebro", "earlier session", "what did I do in", "what did we say about", "find the conversation where", "search my claude sessions", "recall session", "last time we", "how did we solve X before".
---

# cerebro

`cerebro` is a local CLI that indexes **every** Claude Code session (including the
ones Claude Code has already deleted) into a SQLite database and makes them
searchable. It is a verbatim archive: whole conversations, which repo/directory they
belong to, and subagent transcripts. Use it to find what was actually said or done in
an earlier session.

The binary is on PATH as `cerebro`. If it is missing: `bun run /path/to/cerebro/src/cli.ts <command>`.

> Example output below uses made-up test data.

## Workflow (important: index first, progressive disclosure)

Do not drown the context window. Follow this ladder:

1. **`cerebro index`** first if the search concerns recent work (the index is
   incremental and fast; sessions that are open right now may not be fully written yet).
2. **`cerebro search <query>`**, **`cerebro relevant <prompt>`** (relevance-ranked
   against a prompt) or **`cerebro sessions`** / **`cerebro recent`** to find the right
   thread. Gives you only id + timestamp + project + snippet.
3. **`cerebro show <id>`** for an outline of the interesting thread (one line per
   message; a long thread shows the first and last 50 with an omitted marker between).
   The head tells you how the thread opened, the tail how it ended: usually enough to
   judge whether this is the right thread before spending more context on it.
4. **`cerebro show <id> --range A..B`** to read a verbatim slice: around a `search`
   hit's `#N` position, or into the outline's omitted middle. Range is the digging
   tool; take a slice of 10-20 messages, widen only if the answer is not there.
   **`--full`** is the last resort, only when you truly need the whole transcript;
   a long thread's transcript can be hundreds of KB and drown the context window.

Ids can be abbreviated to the prefix (8 characters) the listings show. An ambiguous
prefix errors. The reader commands (`search`, `sessions`, `recent`, `relevant`, `show`,
`stats`, `skills`, `doctor`, `version`, `digest stale|search|show`) take `--json` when you want
the rows as JSON instead of the human-readable listing (an empty result gives `[]`,
never prose).

## Commands

### `cerebro index [--full] [--rebuild] [--dry-run]`
Indexes incrementally since the last run. Every file has a byte cursor: unchanged
files are skipped entirely, files that grew are read only from the cursor onward. So
you do **not** need `--full` day to day, just `cerebro index`. `--full` resets the
cursors and re-reads everything (safe thanks to dedup on message UUID, but slower and
net 0 new on an up-to-date archive; stored text is never touched). `--rebuild` does
what `--full` does but additionally rewrites the stored text of every message whose
source file is still on disk (needed after a change to the flattening logic); messages
whose source file was deleted are left untouched. `--dry-run` reports what would be
indexed without writing anything.

```
$ cerebro index
Indexed 128 new message(s) (3/210 files touched).
```

```
$ cerebro index --dry-run
Dry run. Would index:
  New messages:  128
  New bytes:     412 KB
  Files:         1 new, 2 grown, 0 truncated, 207 unchanged (skipped)

Nothing written. Run `cerebro index` to apply.
```

```
$ cerebro index --full --dry-run
Dry run (--full): would re-read all 210 file(s).
  Candidate messages: 24817 (before UUID dedup)
  Bytes to read:      96.4 MB
  On an up-to-date archive dedup collapses this to ~0 net-new messages.
```

### `cerebro search <query> [--limit N] [--project P] [--branch B] [--since D] [--role R] [--prose] [--all]`
Full-text search (FTS5), ranked with bm25, snippet-first. `[...]` marks matched terms.
Multiple words = implicit AND; quotes for a phrase. Default limit 20. By default it
shows the **best hit per thread** (so a chatty thread does not fill every slot);
`--all` gives every matching message. `--project P` filters on a substring of the
project path (the thread's, so a resume without its own cwd is not lost), `--branch B`
on a substring of the recorded git branch (thread-level too: a thread matches when any
of its sessions was on the branch), `--since 2026-01-31` on timestamp.

Tool calls are flattened into the message text (`[tool_use:Bash] …`, `[tool_result] …`),
which is good for finding commands and filenames but drowns prose. Two filters against
that: `--role user|assistant` and `--prose` (which excludes messages that are *only*
tool plumbing). A `tool_result` counts as a `user` turn, so **`--role user --prose` is
the query "what have I written myself about X"**.

```
$ cerebro search "rate limiter" --limit 2
5e6f7a8b  2026-02-10 09:31  user       api-server  Fix flaky auth test
    #14  … the [rate] [limiter] should return 429 with a Retry-After header when the …
9c0d1e2f  2026-02-08 14:02  assistant  web-shop  Refactor checkout flow
    #52  … checkout calls the [rate] [limiter] middleware before the payment step …

2 hit(s), best per thread (--all for every message). Open one with: cerebro show <id> (jump to a hit: --range <n>)
```

```
$ cerebro search "rate limiter" --role user --prose --limit 1
5e6f7a8b  2026-02-10 09:31  user       api-server  Fix flaky auth test
    #14  … the [rate] [limiter] should return 429 with a Retry-After header when the …

1 hit(s), best per thread (--all for every message). Open one with: cerebro show <id> (jump to a hit: --range <n>)
```

### `cerebro sessions [--project P] [--branch B] [--since D] [--limit N]`
Lists threads, most recently active first. `--project P` filters on a substring of the
project path, `--branch B` on a substring of the recorded git branch (a thread matches
when **any** of its sessions was on the branch, so work that started on master and
moved to a branch in a resume is still found), `--since 2026-01-31` on the thread's
last activity (same date format as `search --since`). Each row shows the thread's
branch as an `@` suffix when one was recorded, `+N resume(s)` for threads that were
resumed and `[body deleted]` when the source file is gone but the archive remains.
Default limit 30. Threads with no indexed turns (a session opened and closed right
away) are not listed, and are not counted in `stats`, but can still be opened with
`cerebro show <id>`.

```
$ cerebro sessions --limit 4
a1b2c3d4  2026-02-12 16:48   162 msgs  my-app @feat/dark-mode
    Add dark mode toggle
5e6f7a8b  2026-02-10 09:31    88 msgs  api-server @main +1 resume(s)
    Fix flaky auth test
9c0d1e2f  2026-02-08 14:02   240 msgs  web-shop @main
    Refactor checkout flow
3a4b5c6d  2026-02-05 11:20    54 msgs  my-app @main  [body deleted]
    Set up CI pipeline
```

```
$ cerebro sessions --project my-app --limit 2
a1b2c3d4  2026-02-12 16:48   162 msgs  my-app @feat/dark-mode
    Add dark mode toggle
3a4b5c6d  2026-02-05 11:20    54 msgs  my-app @main  [body deleted]
    Set up CI pipeline
```

**Catching up on a branch** ("what have we done on this branch so far", getting a
second agent up to speed): take the branch from `git branch --show-current`, list its
threads with `cerebro sessions --branch <branch>`, then read up via
`cerebro digest show <id>` (summary) or `cerebro show <id>` (outline).
`cerebro search "<terms>" --branch <branch>` scopes a search the same way. A session
stores one branch (whichever its most recent indexing run saw first), so a
mid-session branch switch can move the session to the new branch rather than
matching both; treat the filter as a strong hint, not ground truth.

```
$ cerebro sessions --branch feat/dark-mode
a1b2c3d4  2026-02-12 16:48   162 msgs  my-app @feat/dark-mode
    Add dark mode toggle
```

### `cerebro recent [--cwd P] [--days D] [--limit N]`
The latest threads for one repo (default: the current directory, 14 days, 5 threads),
scoped on the git root. Each thread is shown with its opening prompt. Good for getting
oriented in what has happened in a repo lately.

```
$ cerebro recent --limit 2
Recent sessions in my-app (last 14 days):
  a1b2c3d4  2026-02-12   162 msgs  Add dark mode toggle
      opened: Add a dark mode toggle to the settings page, persisted in localStorage
  3a4b5c6d  2026-02-05    54 msgs  Set up CI pipeline
      opened: Set up a GitHub Actions pipeline that runs lint, typecheck and tests

Pull prior context: cerebro show <id>  |  cerebro search "<terms>"
```

### `cerebro relevant <prompt> [--limit N] [--cwd P]`
Past threads most relevant to a prompt (FTS, bm25; Swedish and English stopwords are
filtered out). The ranking is recency-weighted: the bm25 score decays with the thread's
age (90-day half-life), so on an equivalent text match the fresher work wins (`search`
is pure bm25). Threads in the same repo as `--cwd` (the git root, otherwise the exact
project path) additionally get their score multiplied by 1.5 in both tiers, worth
roughly two months of freshness. It is a boost, never a filter: a clearly stronger match
in another repo still shows up, which is the point for shared infrastructure. Without
`--cwd` (and without a cwd in the hook payload) everything is ranked globally. Each hit
has a title, an opening prompt and a matching snippet. Default 3. Good when you want to
know whether something similar has been done before.

```
$ cerebro relevant "how did we set up CI"
Related past sessions:
  3a4b5c6d  2026-02-05  my-app  Set up CI pipeline
      opened: Set up a GitHub Actions pipeline that runs lint, typecheck and tests
      match:  … the [CI] workflow runs on push, cache the bun install step …

To recall one: cerebro show <id> (add --full for the transcript), or cerebro search "<terms>".
```

`recent` and `relevant` take `--context` (an agent-friendly block, silent when nothing
matches) and `relevant` takes `--stdin` (reads the prompt and the cwd out of a hook's
JSON payload). That is what the automated hooks use (see "Good to know").

### `cerebro show <session-id> [--full] [--range A..B]`
Shows a whole logical thread (root + all resumes + subagent turns), ordered
chronologically. Outline by default; past 100 messages it shows the first and last
50 with a marker line in between (`… N message(s) omitted (#A..#B), open a slice
with: cerebro show <id> --range A..B`), so the head tells you how the thread opened
and the tail how it ended without paying for every line. `--full` gives the
verbatim transcript.
`--range 12..18` (or a single number) gives a verbatim slice with the same numbering as
the outline and as the `#N` markers in `search` hits, so you can jump straight to a hit
in a huge thread without pulling the whole transcript. Subagent turns are tagged
`[subagent]`.

Outline:
```
$ cerebro show a1b2c3d4
Thread a1b2c3d4  162 message(s)

  1. user      2026-02-12 15:02  Add a dark mode toggle to the settings page, persisted in localStorage …
  2. assistant 2026-02-12 15:02  I'll start by finding the settings page and the theme provider.
  3. assistant 2026-02-12 15:03  [tool_use:Bash] {"command":"rg -l \"ThemeProvider\" src", …}
  4. user      2026-02-12 15:03  [tool_result] src/theme/ThemeProvider.tsx src/pages/Settings.tsx …
 18. assistant 2026-02-12 15:20  [tool_use:Agent] {"subagent_type":"Explore","description":"Find theme tokens"}
 19. user      2026-02-12 15:20  [subagent] List all color tokens in src/theme …
  … 62 message(s) omitted (#51..#112), open a slice with: cerebro show <id> --range A..B
113. assistant 2026-02-12 16:31  The toggle now persists via localStorage; running the test suite.
162. assistant 2026-02-12 16:48  All tests pass. The dark mode toggle is done.

Full transcript: cerebro show <id> --full
```

Full (excerpt):
```
$ cerebro show a1b2c3d4 --full
Thread a1b2c3d4  162 message(s)

──── user · 2026-02-12 15:02 ────
Add a dark mode toggle to the settings page, persisted in localStorage.
...

──── assistant · 2026-02-12 15:02 ────
I'll start by finding the settings page and the theme provider.
```

### `cerebro stats`
The archive's key numbers: threads (with summary coverage and stale count), sessions,
messages, deleted sources, time span, database size and top projects.

```
$ cerebro stats
Threads:          196 (184 summarized, 12 stale)
Sessions:         210
Messages:         24817
Deleted sources:  12
Span:             2025-11-02 .. 2026-07-01
Database size:    48.2 MB
Top projects:     my-app (58), api-server (33), web-shop (21)
```

### `cerebro skills [--since D] [--limit N]`
How often each named command was invoked. `slash` is a typed `/name`, `model` is a Skill
tool call the model made, `slash + model = total`, and `sub` is the part of `total` that
came from a subagent turn. Both markers are needed: counting only one of them
undercounts by a factor. No default limit, so a rarely used skill is never trimmed into
looking unused.

```
$ cerebro skills --limit 4
top 4 of 78 names, 2026-05-11 .. 2026-08-19 (built-in commands included; sub is the subagent part of total)
name                                slash  model  total    sub  last
clear                                 493      0    493      0  2026-08-19
commit                                 60     86    146      0  2026-08-19
exit                                  136      0    136      0  2026-08-18
changelog                              61      1     62      0  2026-08-18
```

Names come out as they were seen, so Claude Code's built-ins (`/clear`, `/model`) are in
the list and a renamed skill appears twice. `--json` returns an object, not a bare array:
the rows plus `from`/`to`, the window the counts cover. Read a low number with that
window in mind rather than as "unused": anything called before the archive begins is
invisible, and a skill only used in one season looks dead the rest of the year.

### `cerebro doctor [--full]` and `cerebro version`
`doctor` is a read-only health report: SQLite and FTS integrity, the schema version,
orphaned index cursors, empty sessions, WAL size, digest coverage, whether the deployed
binary has drifted from the repo, and whether the hooks are wired in `settings.json`. It
never repairs anything, it points out the command that does. Exit 1 only on a hard
failure (corruption, or a schema this build cannot read), so a warning like a digest
backlog does not turn it red. `--full` runs the complete `integrity_check` instead of
`quick_check`. `version` prints just the build identity, which is what makes the drift
check possible.

```
$ cerebro doctor
running    cerebro 0.1.0 (a1b2c3d, built 2026-07-26T09:12:00Z, bun 1.3.14)
database   /Users/you/.claude/cerebro/archive.sqlite (48.2 MB)

Build
  ok    deployed          a1b2c3d, matches this build

Database
  ok    schema            v5 (current)
  ok    integrity         quick_check
  ok    messages_fts      ok
  ok    summaries_fts     ok
  ok    wal               0 bytes

Archive
  ok    index cursors     210 rows, no orphans
  ok    empty sessions    0
  warn  digest coverage   184/196 threads summarized, 12 stale  -> run the reconciler (hooks/digest-stale-batch.sh)

Hooks
  ok    SessionEnd        index + summarize on /clear

All checks passed, 1 warning(s).
```

### `cerebro backup [--to <path>] [--keep N]` and `cerebro maintain`
Archive housekeeping. `backup` takes a consistent snapshot of the database
(`VACUUM INTO`) into `<db-dir>/backups/archive-<timestamp>.sqlite`; `--to <path>` picks
an explicit target, `--keep N` prunes the oldest default-named backups beyond N.
`maintain` optimizes the FTS indexes, refreshes the query planner's statistics and
truncates the WAL file (the scheduled digest batch runs it automatically). You rarely
need to run these yourself, but they are there when the user asks for a backup or the
archive feels sluggish.

```
$ cerebro backup --keep 8
Backup written: /Users/you/.claude/cerebro/backups/archive-20260702-121530.sqlite (48.1 MB)
```

### `cerebro digest <action>`
A curated layer on top of the raw data: one LLM-written summary per thread, stored in
the same database with its own FTS index. The summaries are dense and topical, so
searching them finds "what was I working on around X" far better than bm25 against raw
transcripts. cerebro owns the prompt, the size tiering and the storage format, and never
summarizes on its own initiative: `digest run`/`digest drain` spawn the model only when
someone asks for it, and the composable verbs (`input`/`prompt`/`write`) are still there
for when you want to be the model yourself.

**When asked to find patterns or related work:** start with `cerebro digest search <query>`
(dense summaries) and then go deeper with `cerebro show <id>`. If that comes back too
thin, complement it with `cerebro search` against the raw data.

**Coverage is a latency question, not just a quality question.** `relevant` only runs its
raw-data tier when the summary tier did not fill `--limit`, and the raw tier is a broad
scan over the message FTS index (one row per message) where the summary tier reads one row
per thread. So summaries short-circuit the expensive half of the lookup: measured with the
compiled binary against a synthetic archive of
300 000 messages (1200 sessions, 148 MB) and zero summaries, `cerebro relevant "<prose prompt>" --limit 5`
took 386 ms, and that shrinks as coverage rises. If the archive is unsummarized,
`cerebro digest drain` is worth running, and not only for recall.

**The summary points at the raw data, and usually it is enough.** Each summary is keyed on
the thread's id, and every `digest` row starts with that id. That is the reference back to
the raw data: in the vast majority of cases the summary is good enough to answer with, and
you do not need to open the transcript. Fetch the raw data **only when needed**, in this
order:
- `cerebro show <id>` for an outline (one line per message, head + tail on a long thread) when you need to see how it unfolded.
- `cerebro show <id> --full` for the verbatim transcript when you need exact wording, code or commands.
- `cerebro search "<term>"` when you want to hit one specific message somewhere in the thread (or in the archive).

Do not drown the context by reflexively pulling `--full`; summary -> id -> outline -> full
is the ladder.

```
$ cerebro digest stale --limit 3
a1b2c3d4  2026-02-12 16:48   162 msgs  my-app  [never summarized]
    Add dark mode toggle
5e6f7a8b  2026-02-10 09:31    88 msgs  api-server  [new activity since summary]
    Fix flaky auth test
9c0d1e2f  2026-02-08 14:02   240 msgs  web-shop  [prompt v1 < v2]
    Refactor checkout flow

3 thread(s) need a summary. Summarize one:
  cerebro digest run <id>          (or drain the backlog: cerebro digest drain --limit N)
```

```
$ cerebro digest run a1b2c3d4
Summarized a1b2c3d4: 48213 bytes -> claude-haiku-4-5, 612 chars.
```

```
$ cerebro digest search "how did we do the rate limiter"
5e6f7a8b  2026-02-10 09:31  api-server  Fix flaky auth test
    Added a token-bucket [rate] [limiter] to the auth middleware in api-server …

1 summary hit(s). Open one: cerebro show <id>  |  full summary: cerebro digest show <id>
```

```
$ cerebro digest show 5e6f7a8b
Summary for thread 5e6f7a8b  (2026-02-10 09:31, claude-opus-4-8, prompt v1)

Added a token-bucket rate limiter to the auth middleware in api-server. ...
Keywords: src/auth/middleware.ts, rate-limiter, 429, Retry-After
```

**Producing a summary.** Three routes:
- `cerebro digest run <id>` does the whole chain in one step: renders the transcript,
  picks the model by size, spawns `claude -p --no-session-persistence`, refuses to store
  output that cannot be a summary, and writes it in. Exit 0 only when something was
  actually stored. `cerebro digest drain --limit N` does the same for the N stalest
  threads, newest first, and does not let one broken thread stop the rest. This is what
  the hooks run. `CEREBRO_CLAUDE_BIN` controls which binary is spawned.
- Or you as the agent do it inline: read `cerebro digest input <id>`, summarize per
  `cerebro digest prompt`, and write it back with `cerebro digest write <id>` (the summary
  is read from stdin; `--model <name>` records which model wrote it). No subprocess
  involved, you are the model.
- Or pipe the steps yourself: `cerebro digest input <id> | claude -p "$(cerebro digest prompt)" | cerebro digest write <id>`.

`digest write` refuses to store text that cannot be a summary (too short, or something
that looks like an error message along the lines of "Prompt is too long"/"API Error") and
exits 1 when it does, leaving the thread stale so the reconciler retries it. The same
guard sits in `digest run`/`drain`.

Use `cerebro digest input <id>`, not `show <id> --full`, as model input: it renders the
same transcript but size-bounded so it fits in a single model context. Short threads come
out verbatim; a giant thread is trimmed (water-fill: short messages are kept whole, the
longest essays are trimmed first) so that not even a 1M context is blown. cerebro owns the
model choice: `digest run`/`drain` measure the transcript where they render it and tier on
that, and `cerebro digest model <id>` (or `--bytes <n>`) shows the same decision for a
manual check. Small threads -> `claude-haiku-4-5` (cheapest, the common case), oversized
-> `claude-sonnet-4-6[1m]` in one shot (1M context, flat pricing, no long-context premium),
so that a thread of 400-600k tokens is summarized whole instead of truncated. The `[1m]`
suffix is required: that is how Claude Code picks the 1M variant; without it `claude -p`
gets the default 200k window and a giant thread still fails with "Prompt is too long".
The threshold and the model names can be overridden via `CEREBRO_DIGEST_MODEL`,
`CEREBRO_DIGEST_MODEL_LARGE` and `CEREBRO_DIGEST_HAIKU_MAX_CHARS`.

`cerebro digest drain` is the reconciler: run it now and then (or on a schedule) and
everything unsummarized or out of date is caught, and `cerebro digest stale` shows the
backlog without touching it. A thread becomes stale again when it gains new messages or
when the prompt version (`DIGEST_PROMPT_VERSION`) is bumped. `--ids` gives a
machine-readable mode (one full thread id per line, no formatting) that scripts and hooks
can loop over without scraping the human-readable listing; empty output means nothing is
stale.

## Indexing (mental model)

- **`cerebro index` is all you need day to day.** It is incremental: every file has a
  byte cursor (`index_state`) with how far we have read plus the file's mtime. Unchanged
  files are skipped entirely, files that grew are read only from the cursor onward.
  Re-running is cheap.
- **Run `index` before searching fresh work.** The active session is written to disk
  continuously and is picked up on the next indexing run.
- **`--full` is almost never needed.** It resets the cursors and re-reads everything from
  the start. Dedup on message UUID makes that harmless (net 0 new on an up-to-date
  archive), but it is slower. Use it only on a suspected-broken cursor state. After a
  change to how messages are flattened to text, `--rebuild` is the one you want: it also
  updates the stored text (for files that are still on disk).
- **`--dry-run` writes nothing**, it only reports what a run would do (new messages,
  bytes, the file breakdown). Good for inspecting before a large `--full`.
- **Dedup on UUID, not file or session id.** The same message appearing in several files
  (resumes, subagent echoes) is stored once. That is why `--full` never produces
  duplicates.

## Good to know

- **Database:** `~/.claude/cerebro/archive.sqlite` (override with `--db <path>` or
  `$CEREBRO_DB`). It deliberately lives outside the git repo: it holds private
  conversations verbatim and grows large (tens of MB+).
- **Time zone:** timestamps are stored as verbatim UTC and displayed in
  `Europe/Stockholm`. `$CEREBRO_TZ` takes any IANA zone; an unknown zone falls back to
  the default rather than crashing.
- **tool_use / tool_result** are flattened to greppable text (`[tool_use:Bash] {...}`,
  `[tool_result] ...`), so you can search for commands and file contents that were
  actually run. Each such block is capped at the first 1 KB (with a
  `[+N chars truncated]` marker) because the head holds the searchable part (tool name,
  file_path, command) while the rest is reproducible noise. Prose and reasoning are
  stored verbatim; errors (`[tool_result:error]`) are not capped.
- **Threads fold in resumes:** `sessions` shows roots only; resumed sessions and
  subagent work appear inside `show`.
- **Recall is on demand, nothing is injected.** No hook feeds past threads into a
  conversation; if earlier work is worth knowing about, run `relevant` / `search` /
  `digest search` yourself. `relevant` matches the **summaries first** (curated, high
  signal) and falls back on raw-data bm25 for threads not yet summarized; a hit marked
  `summary:` comes from the summary, `match:` from the raw data. Pass `--cwd` to boost
  threads from that repo.
- **One automated hook:** `SessionEnd` on `/clear` indexes synchronously and then runs
  `cerebro digest run --stdin` detached for the session just cleared (best-effort;
  `cerebro digest drain` is the reconciler that catches what is missed).
