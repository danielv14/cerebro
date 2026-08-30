# Architecture and design notes

How cerebro's modules fit together and why they are shaped the way they are.
The code itself keeps its comments short and local (a specific edge case, a
non-obvious constraint); the module-level story lives here. The load-bearing
invariants are in `CLAUDE.md`; this document explains the design around them.
It is deliberately not an inventory: it covers the decisions a reader cannot
recover from the code, and it should shrink when code starts explaining itself,
not grow with every change. The inventory, one line per module, is
[layout.md](layout.md).

The pipeline, end to end:

```
source adapters (discovery + normalization)
  -> scan layer (byte cursors, complete-line splitting)
  -> indexer (dedup ingest, session rows, thread relinking)
  -> SQLite archive (messages, sessions, FTS indexes, threads view, summaries)
  -> query surfaces (search, sessions/recent, relevant, digest, skills, stats)
  -> CLI (commands as data, one dispatcher that parses, validates and renders)
```

## Sources (`src/sources/`, `src/jsonl.ts`)

The source-adapter seam decouples the archive from any one AI tool. Each
adapter owns two things: discovering its session files on disk and normalizing
raw JSONL lines into the `Classified` events the indexer stores. Everything
downstream (scan, schema, FTS, search, relevance, digests) is source-agnostic.
The full adapter contract and its guarantees are in
[source-adapters.md](source-adapters.md).

- `adapter.ts` declares the contract: `SessionFile`, `Classified`,
  `SourceAdapter`, and `parseLine` (returns `undefined` on parse failure so a
  malformed line is distinguishable from a line that parses to a falsy value).
- `claude-code.ts` owns the Claude Code on-disk layout: top-level
  `<project>/<session-uuid>.jsonl` files, and `<uuid>/subagents/*.jsonl`
  transcripts attributed to the parent session (invariant #6). Discovery is
  unsorted; the registry orders the merged set.
- `registry.ts` merges every adapter's files and sorts oldest-first by mtime,
  tiebreak sessionId (invariant #3: an original session must be indexed before
  any resume that branches from it). `adapterFor` throws on an unknown
  provider: files only enter the pipeline through an adapter's own discover, so
  an unknown provider is a programming error, not something to guess around.
- `jsonl.ts` is the normalization half of the Claude Code adapter and one of
  cerebro's untrusted I/O boundaries. The accepted shapes are Valibot schemas
  validated with `safeParse`, deliberately tolerant of an evolving log: an
  unknown event type classifies to `skip`, a missing or wrongly-typed optional
  field defaults to null, an unrecognized content block is dropped, and unknown
  keys are ignored. For the message variant only `type`, `uuid` and `message`
  are load-bearing; the optional scalars stay `unknown` and are coerced in the
  mapping, so a changed field type degrades that field instead of dropping the
  whole turn. `flattenContent` renders block arrays as greppable text: prose
  and thinking pass through, tool blocks get a compact tag and a size cap
  (tool plumbing dominates transcript bytes and ages worst; the head of the
  payload carries the searchable identifiers, and errors are exempt because a
  truncated stack trace is useless). `toolUseTag` is exported so `skills`
  derives its marker from the flattener instead of duplicating the string.

## Scan layer (`src/scan.ts`)

Bytes, cursors, mtimes and `index_state`; nothing about messages or sessions.
`runIndex` and `dryRunIndex` both consume this module, which is what makes
invariant #2 (they must agree on what counts as indexable) structural: there is
one splitter (`splitBuffer`), one read plan (`planFileRead`), and one
discover-state-plan-read-split walk (`eachIndexableFile`).

The per-file cursor is a byte offset, so reads work on bytes: `0x0A` never
appears inside a UTF-8 multibyte sequence, making a newline split of the byte
buffer safe (invariant #1). `splitBuffer` only advances the cursor past a
trailing newline, or past a final unterminated line that parses as JSON; an
unparseable tail is a mid-write line left for the next run.

`planFileRead` decides skip/read/truncate per file. A file flagged `is_digest`
(cerebro's own summarization transcript, see below) is permanently excluded
even when it grows: the content guard only inspects reads that start at byte 0,
so without the flag a digest transcript still being written when first detected
would leak its later lines into the archive on the next incremental run.

`orphanedCursorPaths` is the one owner of the orphan predicate: the indexer's
presence reconciliation deletes through it and `doctor` counts through it, so
the diagnostic can never disagree with what `cerebro index` would prune. It
returns null on an empty scan, because an empty scan almost always means a
transient readdir failure rather than every session being deleted; "unknown"
must stay distinguishable from "no orphans".

## Indexer (`src/indexer.ts`)

`runIndex` walks the scan layer's output inside a per-file transaction:
classify the new lines, insert messages deduped on UUID (invariant #4), then
write the session row. `--full` clears cursors and re-reads everything (dedup
makes it idempotent); `--rebuild` additionally refreshes the payload of
already-indexed messages in place (the only way a `flattenContent` change
reaches old rows) while never touching `session_id` or deleting anything, so
messages whose source file is gone keep their only copy.

Two session-row writers exist on purpose (invariant #7):

- `upsertSession` treats the top-level file as the authority for its session:
  the incoming value wins each `COALESCE`, and the title is guarded by the
  stored `title_priority` so an incremental run that only sees a later,
  lower-priority title event (e.g. a `summary`) can never clobber a
  `custom-title` indexed earlier.
- `touchParentSession` is for subagent files: the existing row wins each
  `COALESCE` so a subagent never clobbers the parent's identity fields, the
  fields a subagent cannot know are passed NULL, and `title_priority` is
  frozen.

Merging them behind a `prefer` flag is a decided non-goal: it hides the one
thing that differs, and a wrong merge silently mis-attributes sessions.

`reconcilePresence` reconciles the archive against disk: sessions whose source
file is gone are flagged body-unavailable (a NULL `source_file`, i.e. a
subagent-only parent stub, correctly reads as unavailable too), and
`index_state` cursors for vanished files are pruned. Unlike sessions and
messages, where the row *is* the archive, a cursor into an unreadable file
carries no information, and Claude Code deletes session files on its own
schedule, so without pruning the one working table grows forever. A pruned file
that reappears is re-read from byte 0 and UUID dedup makes that a no-op.

`isDigestRunTranscript` keeps cerebro's own headless `claude -p` summarization
runs out of the archive: such a transcript opens with the digest prompt as a
user message, and indexing it would feed prompt boilerplate back into search.
New digest runs pass `--no-session-persistence` and write no transcript at all;
the guard covers transcripts already on disk. Detection only runs on reads that
start at byte 0, and a detected file is flagged `is_digest` so it is never read
again.

`relinkThreads` only runs when at least one file was read: a run that read no
file inserted no message, so no new cross-session parent link can exist. This
keeps a no-op index O(files discovered) instead of O(archive), which is what
keeps the synchronous `/clear` hook cheap. The accepted consequence: a run that
crashed after ingest but before the relink leaves stale links that a later
no-op run does not repair; `cerebro index --full` always relinks. The gate is
on files read, not the message delta, because a file can contribute only title
events.

`dryRunIndex` reports what a run would do through the exact same scan and skip
logic, writing nothing. `candidateMessages` is counted before UUID dedup: in
incremental mode new bytes are genuinely new so it equals net-new, while a
`--full` dry run reports the whole archive.

## Database (`src/db.ts`)

`openDb` stamps `SCHEMA_VERSION` into `PRAGMA user_version` and skips all DDL
when the stamp matches and the threads view has the expected shape, so the
hot-path open does no schema work. DDL, migrations and the stamp commit as one
`BEGIN IMMEDIATE` transaction: two binaries built for different schema versions
racing the first open after an upgrade could otherwise interleave a
current-looking stamp over the other build's view, which the version gate would
trust forever; the view-shape re-check heals databases an old unwrapped binary
already wedged. The migrations are check-then-ALTER, so they need the same
write lock to keep the loser from throwing on the winner's column.

Connection pragmas (busy_timeout, foreign_keys, WAL) run on every open, outside
the version gate: cerebro is opened concurrently by short-lived processes
against one WAL file, and the 5s busy_timeout rides out checkpoint and
WAL-recovery windows that would otherwise fail instantly with SQLITE_BUSY.

`messages.line_no` is legacy, always NULL, and kept on purpose: the deployed
hook binary is a frozen snapshot whose INSERT names the column; dropping it
would make every automated index run fail silently until the next deploy.

The FTS tables are contentless-delta (`content=` tables) kept in sync by
insert/delete/update triggers; the update triggers exist because `--rebuild`
updates message text in place and re-summarizing upserts summaries.

## Threads (`src/thread.ts`)

The thread module owns what a thread is, end to end: identity and membership,
the `threads` rollup view (DDL and row shape), the listings that read it, and
`relinkThreads`, the sole writer of `root_session_id`. A logical thread is a
root session plus its resumes and folded subagent transcripts, all sharing one
`root_session_id`. The db module consumes the view DDL as an opaque fragment,
so adding a rollup column is a one-file change here plus a `SCHEMA_VERSION`
bump.

Key design points:

- **Membership is expressed once** (`THREAD_MEMBERSHIP`): every reader that
  scopes to a thread's sessions composes the same fragment, so the rule cannot
  drift between queries.
- **The view is root-preferring**: a rollup column takes the root session's
  value and falls back to MAX over the resumes only when the root's is NULL.
  The aggregate runs over unfiltered rows; callers that scope by project filter
  the view's *output*, because filtering raw sessions before the GROUP BY would
  drop resume/subagent rows whose project_path is NULL or differs.
- **The view's columns are declared once** (`THREADS_VIEW_COLUMN_EXPRS`) and
  drive both the CREATE VIEW and the shape check `openDb` runs, so the two
  cannot drift. The shape check exists because `CREATE VIEW IF NOT EXISTS`
  silently keeps an old view; see the db section for the race it closes.
- **`HAVING SUM(msg_count) > 0`** is what makes "a thread" mean the same thing
  to every reader: a session opened and closed right away still gets a sessions
  row (sidecar metadata that outlives Claude Code's own cleanup) with zero
  messages, and excluding it in the view rather than per listing keeps
  `countThreads`, `topProjects` and the listings agreeing. Nothing is deleted;
  `show` on such a session still resolves.
- **The branch filter is any-session**, not root-preferring: branch work often
  starts in a resume of a thread whose root sat on master, so a thread touches
  a branch when any of its sessions was recorded on it. `search --branch` and
  `sessions --branch` compose the same `threadOnBranch` fragment.
- **`attachThreadDisplay`** is the step every ranked-hit path runs after dedup:
  hydrate the rollup once for the whole batch and pair each hit with its
  thread's display identity, leaving the caller to map that into its own result
  shape. It reads that identity from the
  rollup, not the root's own sessions row: for a thread with resumes the root's
  row carries the first session's `last_ts` and often no title, which made
  `relevant` and `digest search` disagree with `sessions` and `recent` on the
  same thread. A root with no rollup row gets the caller's fallback rather than
  being dropped (a summary must survive its sessions rows being deleted), and
  the fallback is an argument because the two policies in use are both
  deliberate and used to be invisible: `search` answers from the matched
  session's own columns, `relevant` and `digest search` from nothing.
  `threadDisplay` is the single construction site for the shape, which is what
  fixes the JSON key order of the two callers that spread it whole; a test pins
  that order for all three listings. Owning
  the step here is what keeps a new display column (`provider` and `model` cost
  five source files and five test files) from being paid for three times.
- **`messageOrdinal`** computes a message's 1-based position with ROW_NUMBER
  over the exact ORDER BY that `threadMessages` sorts with, owned next to it so
  search's `#N` ordinals and `show`'s numbering share one definition.
- **`relinkThreads`** builds thread identity across resumes: a resume's first
  main-chain message has a `parentUuid` owned by an earlier session; chaining
  those parents up gives each thread's root. Sidechain rows are excluded (the
  resume link lives on the first main-chain turn). Ordering is by id, not ts:
  for a session's main-chain messages, insertion order equals file order equals
  conversational order on every path, so the lowest id is the true first turn
  even with missing or unordered timestamps. The walk to the root guards
  against cycles. Cost is linear in archive size, which is why `runIndex` gates
  it on having read a file.

## FTS layer (`src/fts.ts`)

One owner of the ranked-hit query shape over `messages_fts`. `search` and
`relevantThreads` used to carry their own copy of the FTS-join-sessions-join-
rollup query and their own spelling of "best hit per thread root", and the two
paths repeatedly disagreed about the same thread. The join, the dedup and the
window growth live here once, and the step after them (hydrating the thread
rollup and attaching it to each hit) is `attachThreadDisplay` in the thread
module, which owns that metadata. A caller keeps its ranking function, the size
of its first fetch, its fallback policy and its own result shape.

- `escapeLike` escapes user-supplied LIKE fragments; every LIKE built from user
  input pairs it with an explicit `ESCAPE '\'`.
- `toMatchQuery` turns prose into an OR-of-tokens FTS5 query: implicit AND
  would require every word to co-occur and return nothing for a conversational
  prompt, and Swedish/English stopwords are dropped via the `stopword` package
  so filler words do not match unrelated threads.
- `rankedMessageHits` attaches both the matched message's own session row
  (display fallbacks for a thread whose rollup row is gone) and the thread
  rollup via LEFT JOIN (root-preferring `last_ts`/repo, so a resume with a NULL
  git_root still ranks with the thread's repo). The root is coalesced to the
  session itself for not-yet-relinked sessions so a rootless hit is never
  dropped. It throws on a malformed MATCH so each caller keeps its own
  fallback.
- `dedupedHitWindow` implements the shared window policy: fetch
  `max(minRows, targetRoots * rowsPerRoot)` top rows, keep the best hit per
  root, and grow the window geometrically (x4, up to 3 rounds) only when it was
  genuinely exhausted: fewer distinct roots than asked for AND a full window
  came back. A fixed window is not enough because one chatty thread can own
  every row in it and starve the threads ranked below. Growth re-fetches one
  deep window rather than paging with LIMIT/OFFSET: `ORDER BY bm25 LIMIT n`
  uses a bounded top-N sorter, so a deeper n is nearly free while every extra
  page re-ranks the whole match set. Callers on a latency path can disable
  growth and answer out of the first fetch.

## Search (`src/search.ts`)

The `search` command's semantics: user queries pass to MATCH verbatim so power
users can use FTS5 operators; on a syntax error the query is retried once as a
sanitized phrase query of the bare tokens (the retry wraps the whole window,
because a query FTS5 accepted once stays valid at every window size). Results
are deduplicated to the best hit per thread by default; `--all` disables that.

Filter semantics worth knowing:

- `--project` is thread-level: it reads the root's representative project_path
  from the rollup rather than the matched message's own session row. Filtering
  on the session would silently drop every hit in a resume whose lines carry no
  cwd or a differing one (a subdirectory, a worktree, a moved repo). The
  rollup value is the same one `sessions --project` matches on, so the two
  commands agree by construction.
- `--branch` is any-session (see the thread section).
- `--since` is per message, deliberately: it is a property of the turn, not the
  thread.
- `--prose` is a prefix heuristic, not a parser: a tool-only message always
  starts with `[tool_` as `flattenContent` renders it. A message that opens
  with prose and calls a tool further down is kept on purpose.

Title, project, provider and model on a hit are the thread's, attached by
`attachThreadDisplay` in one query over the kept hits; `ts` and `git_branch`
stay the matched message's own, and a search hit carries no thread `last_ts` at
all. `search` passes the session-row fallback policy, so a hit whose thread has
no rollup renders on its own session row instead of losing its title and
project. The ordinal is computed once per kept hit rather than in the hit
query, where it would run a thread-wide COUNT for every matched row the sorter
sees.

## Relevance (`src/relevance.ts`)

`relevant` answers "what past work relates to this prompt", which is a ranking
question rather than a lookup. Two FTS tiers, ranked within each tier because
bm25 scores are not comparable across the two indexes:

1. **Curated summaries first**: dense and topical, so a match there is far
   higher-signal than raw-transcript bm25.
2. **Raw transcripts** top up threads with no summary yet, so the command keeps
   working during backfill and for un-summarized recent sessions.

Within each tier the bm25 score is recency-decayed (`decayedRank`): half-life
90 days, unknown age treated as a year. bm25 is negative (lower = better), so
multiplying by a decay factor in (0,1] shrinks an old hit's magnitude toward 0.
`search` and `digest search` stay pure bm25 on purpose: an explicit search
should be deterministic text relevance; the recall surface should favor fresh
work.

The same-repo boost (`repoBoost`, 1.5x) prefers threads in the repo the prompt
was typed in, matched on the thread's git_root when the cwd is in a repo, else
on exact project_path (the same pairing `recent` scopes by). 1.5x is worth
roughly two months of recency at the 90-day half-life. It is a boost, never a
filter, so a much stronger cross-repo match stays reachable.

Both tiers hand their chosen roots to `attachThreadDisplay` with the
null-fallback policy, so the display identity is read once for the whole result
and lives in the thread module rather than here.

The raw tier's window is deduped on the tier's own decayed-and-boosted rank
(not on bm25), so the hit kept per thread is the one it actually ranks on.
Growth is off at the default limit of 3: `relevant` was built for a
per-prompt-latency budget, the first window holds far more than three threads
unless the archive has barely any matches at all, and that is the one case a
deeper fetch cannot fix. A caller that raises `--limit` has traded latency for
coverage and gets the growth rounds.

## Digest (`src/digest/`)

The curated-summary layer: one LLM-written summary per thread, stored in the
same database. `index.ts` is the package's public surface; code outside
`src/digest` imports from there, so the internal split can change without
touching callers.

- **`prompt.ts`** owns the summarization contract: the prompt, its version
  (bump it to invalidate existing summaries; `staleThreads` then re-surfaces
  them), the size-to-model tiering and the transcript rendering. cerebro has no
  tokenizer, so transcripts are sized in bytes at a conservative 3
  bytes/token; the budget reserves ~90k tokens for `claude -p`'s own system
  prompt, tools and the response (a measured overflow showed ~77k tokens of
  fixed non-transcript overhead). `buildDigestInput` renders a thread verbatim
  below budget; above it every message is kept but each body is capped to the
  fair share found by a binary-search water-fill, so short steering messages
  stay whole while the longest essays are trimmed first. The tiering numbers
  and env overrides are documented in
  [digest-model-tiering.md](digest-model-tiering.md).
- **`stale.ts`** owns the staleness predicate (never summarized, summarized
  before the thread's latest activity, or summarized by an older prompt
  version), defined once for the listing, the count and the coverage reading so
  they cannot drift.
- **`store.ts`** owns storage and the summary FTS search. `rejectSummaryReason`
  is the storage guard: a past incident stored a "Prompt is too long" error as
  a summary through a pipeline that skipped the exit-code gate, so the storage
  contract itself refuses error-shaped or fragment-length text.
  `writeSummary` stamps `source_last_ts` from the moment the transcript was
  rendered, not when the model returned: a call takes minutes, and messages
  indexed in between must stay stale rather than be marked covered by a summary
  that never saw them. `searchSummaryRoots` is the single owner of the
  summaries_fts query shape, shared by `relevant`'s summary tier and
  `digest search`; `searchSummaries` attaches display identity through
  `attachThreadDisplay` on the null-fallback policy, which is what lets a
  summary outlive its sessions rows.
- **`config.ts`** resolves the digest environment (`CEREBRO_DIGEST_MODEL`,
  `CEREBRO_DIGEST_MODEL_LARGE`, `CEREBRO_DIGEST_HAIKU_MAX_CHARS`,
  `CEREBRO_DIGEST_TIMEOUT_MS`, `CEREBRO_CLAUDE_BIN`) into one `DigestConfig`.
  The CLI edge calls it once per invocation and passes the result down, so
  nothing in the pipeline reads `process.env`: the tiering, the timeout and the
  binary path are arguments, and a test supplies them directly instead of
  mutating the process's environment and restoring it.
- **`run.ts`** is the summarize pipeline (render, tier, call, guard, store) and
  the one place cerebro spawns a model, behind the `Summarizer` seam
  (`createClaudeSummarizer` builds one that spawns the CLI with the configured
  binary and timeout; tests pass a fake). The pipeline used to
  live twice in bash, untestable and drifting. The spawn passes
  `--no-session-persistence` so the one-shot run is not recorded as a session
  the indexer would then have to skip, and enforces a generous timeout so a
  wedged call cannot hang a drain forever (a timeout is an ordinary failure;
  the thread stays stale and is retried). A `fatal` result (the binary cannot
  be run at all) aborts a drain, since every remaining thread would fail the
  same way; any other per-thread failure is counted and the drain continues.
  An empty rendered transcript is never summarized: the prompt would dutifully
  answer with the no-content form and storing it would permanently mark the
  thread fresh.

## Skills (`src/skills.ts`)

Counts how often each named command was invoked, out of the archive. It lives
in cerebro because the markers do: a skill call is text inside a turn, one of
the two forms is cerebro's own flattener rendering, and an outside consumer
counting those strings would silently report every skill as unused the day the
flattener changes. "Named command", not "skill", is the honest unit: the slash
marker is Claude Code's expansion of any `/name`, built-ins included, and
filtering them would be a denylist to maintain.

The counting rules deal with quoting: a marker only counts when it opens a line
(a real slash expansion always does; mid-line occurrences are cerebro's own
listings quoted back through a tool_result), the role decides which marker can
appear at all, user turns that open with a flattened tool tag are machine
output, and names are bounded by a shape regex so an unclosed tag cannot turn
an arbitrary slice of transcript into a "name". The model-side payload is
matched with a regex rather than JSON.parse because the tool-text cap truncates
long argument lists mid-JSON, which would drop exactly the calls that carry
arguments.

## Doctor (`src/doctor.ts`)

A read-only health report: doctor never repairs, prunes, optimizes or deploys;
it reports and names the command that fixes each thing. A diagnostic that
mutates is not trustworthy on an archive that is the only copy of deleted
sessions. Only "fail" (corruption, a schema this build cannot speak) sets exit
1, so doctor works as a cron guard without going red on warnings; "unknown" is
what a check degrades to when its input is unreadable, each check
independently. `quick_check` is the default integrity form because
`integrity_check` walks every page and is slow on a large archive; `--full`
opts in. The deployed-drift check spawns the deployed binary's `version` and
compares build stamps, which is why `version` must answer without opening the
archive.

The two checks that probe the machine rather than the archive (that binary and
`settings.json`) take their paths as arguments, resolved at the CLI edge from
`deployedBinaryPath()` and `claudeDir()`. Doctor stays read-only by
construction and stops deciding on its own where to look, so a test points them
at a fixture instead of steering `CLAUDE_CONFIG_DIR` and restoring it.

## CLI (`src/cli.ts`, `src/commands/`)

The command shape (options as data, one dispatcher owning parsing, validation,
db lifetime and rendering) is documented in `CLAUDE.md` ("How a command is
shaped"). Details that live in the code:

- The dispatch table is a Map so a command name colliding with an
  `Object.prototype` key can never resolve to an inherited function.
- `buildParserOptions` builds the whole option vocabulary as one table because
  `parseArgs` needs it before the command is known; a name declared with two
  different kinds throws at startup naming both sides, because resolving it
  silently would break the losing command for every user.
- Rejecting undeclared flags is the check that used to be missing:
  `cerebro sessions --keep 3` used to parse fine and silently ignore `--keep`.
- The `CliIO` sink exists so tests can drive `runCli` with a capturing sink and
  assert on lines and exit code without spawning the binary.
- `CommandOutput.silentWhenEmpty` is the contract with context-injecting hooks:
  silence means "inject nothing", and an empty-state line would end up in the
  model's context.
- `progress` exists for `digest drain` alone: it makes up to N model calls over
  minutes and its only witness is a log file someone tails; buffering the lines
  would make a hung call indistinguishable from a slow one.
- `version` is db-less on purpose: doctor's drift check spawns the deployed
  binary's `version`, and that answer must not depend on whether its archive is
  readable.
- The ambient values a command reads (`now`, `cwd`, `resolveGit`) come from the
  dispatcher, one per run, and are injectable. `resolveGit` is the
  `GitResolver` seam: `index` hands it to `runIndex`, `recent` and `relevant`
  scope by the root it returns, and a test drives the whole command with a
  known repo state instead of depending on which directories on the machine
  happen to be git repos.

Renderers live with their commands; `render.ts` keeps only the shared
vocabulary (id/time/path/size shorthands). CLI output is consumed by hooks and
agents, so exact bytes are load-bearing: spacing, widths, truncation lengths
and labels are pinned by tests. Timestamps are stored verbatim UTC and
displayed in wall-clock time (default zone Europe/Stockholm, `CEREBRO_TZ`
overrides); the sv-SE locale is not a preference but what produces the
`YYYY-MM-DD HH:mm` shape the tests pin, so it stays fixed while the zone moves.

## Backup (`src/backup.ts`)

The archive is the only copy of every session Claude Code has already deleted,
so it has a backup story of its own. `VACUUM INTO` takes a consistent snapshot
even against a concurrently-writing WAL database and produces a compacted
single file. Pruning (`--keep`) only ever touches the default directory and the
default name pattern, so a custom `--to` target or any other file living there
is never deleted.

## Build stamp (`src/build-stamp.ts`, `src/digest-signature.ts`)

The automated paths run a compiled binary, not the source, so a code change
does not reach them until `bun run deploy`; without a stamp that drift is
invisible. The three identifiers are substituted by `bun build --define` and
deliberately do not exist in a source run (`typeof` on an undeclared identifier
is legal), so `bun run src/cli.ts` reports itself as unbuilt rather than
claiming a commit it does not have.

`digest-signature.ts` holds the digest prompt's opening sentence in a leaf
module (no imports) so the indexer can recognize cerebro's own summarization
transcripts without pulling in the digest layer. Rewording that opening stops
digest transcripts already on disk from being detected on a `--full` re-read.
