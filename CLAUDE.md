# cerebro

A Bun + TypeScript CLI that indexes every Claude Code session JSONL into a local
SQLite archive and makes it searchable, incrementally and verbatim. See `README.md`
for what it does, install, usage, and architecture. This file is for working on the
code.

## Stack

- Bun >= 1.2.6 (the digest timeout rides on Bun.spawnSync timeout/exitedDueToTimeout,
  added in 1.2.6), `import { Database } from "bun:sqlite"` (synchronous API). Two small
  pure-JS runtime dependencies: `stopword` (relevance stopword filtering) and
  `valibot` (runtime validation at the I/O boundaries; see the I/O-boundary rule
  below). Dev deps are types only plus Biome (lint + format). Do not add native or
  network runtime deps.
- **Valibot validates the untrusted I/O boundaries only**: the session JSONL events
  and content blocks in `jsonl.ts` (`classify`, `flattenContent`) and the two hook
  stdin payloads (`parseHookPayload` in `src/commands/relevant.ts`,
  `parseSessionEndPayload` in `src/commands/digest.ts`). Anything that comes out
  of SQLite or is
  built internally (the `db.query(...).get/all(...) as X` rows, `FileMeta`,
  `ThreadRow`, and the other internal shapes) stays typed by interface
  plus a cast. Do not wrap queries or internal structures in schemas: the cast
  documents a shape cerebro itself owns, and re-validating it would only add overhead
  on the hook hot path.
- TypeScript strict, `moduleResolution: bundler`, `.ts` extensions in imports.
- Code style follows the global conventions (const arrow functions, async/await,
  no em dashes in output) and is enforced by Biome (`biome.json`): 2-space indent,
  double quotes, semicolons, trailing commas, 100-col width. Everything written in the
  repo is English: commits, comments, CLI output, `README.md`, `docs/` and the skill.
  The repo is public and cloneable, so Swedish prose does not belong in it (the only
  Swedish that does is data: the `swe` stopword list and the tokenizer examples).

## Developing and testing

- Typecheck: `bun run typecheck` (must stay green before you finish).
- Lint + format: `bun run check` (read-only, the same `biome ci` CI runs) or
  `bun run check:fix` to apply. Config in `biome.json`: `noNonNullAssertion` is off
  (the code uses `!` deliberately). The codebase carries no `biome-ignore` escapes;
  the JSONL parser is validated with Valibot rather than narrowing `any`. Keep it clean.
- Tests: `bun test`. The suite under `test/` runs against an in-memory SQLite DB
  (`:memory:`) plus temp fixture session files pointed at by `CEREBRO_CLAUDE_DIR`;
  helpers live in `test/fixtures.ts`. It covers the critical paths: byte/cursor
  splitting, dedup + incremental indexing, subagent folding, thread relinking,
  session-file discovery (`test/paths.test.ts`: ordering, tiebreak, subagent walk),
  git resolution (`test/git.test.ts`: root + remote, missing-dir tolerance),
  dry-run parity, CLI dispatch (`test/cli.test.ts`: the pinned per-command option
  tables, per-command rejection of foreign flags, and each command via an injected
  db and capturing sink), option coercion (`test/commands/args.test.ts`), the
  relevance ranking (`test/relevance.test.ts`: both FTS tiers, recency decay,
  same-repo boost), the digest layer (staleness, model tiering) and its summarize
  pipeline (`test/digest-run.test.ts`: every failure mode through a fake Summarizer,
  plus the real adapter against a stand-in `claude` script), and every query
  function. Add tests when you touch these.
- Run locally: `bun run src/cli.ts <command>`, or the linked `cerebro` on PATH
  (`~/.local/bin/cerebro` -> `src/cli.ts`). The PATH symlink tracks the repo live.
- **Rebuild the deployed binary after code changes.** The `SessionEnd`/clear hook
  runs a *compiled* snapshot at `$CLAUDE_CONFIG_DIR/cerebro/cerebro`
  (defaults to `~/.claude/cerebro/cerebro`), not the source. Code edits (e.g. to
  `flattenContent`) do not affect automated indexing until you redeploy: `bun run deploy`
  (builds, then copies the binary plus `hooks/summarize-on-clear.sh` into the Claude
  config dir). The clear hook runs the deployed script, which indexes synchronously
  then fires a detached `claude -p` summary; edits to the script or the digest prompt
  also need a redeploy to reach the automated path.
- **Never test against the real archive.** Point at a throwaway DB so you do not
  pollute `~/.claude/cerebro/archive.sqlite`:

  ```sh
  export CEREBRO_DB=/tmp/cerebro-test/archive.sqlite
  rm -rf /tmp/cerebro-test
  bun run src/cli.ts index
  ```

  `CEREBRO_CLAUDE_DIR` overrides the scanned `~/.claude` directory if you want a
  fixture set of session files.

## How a command is shaped

Every command is a `defineCommand({ options, run })` under `src/commands/`
(`digest` is a `CommandGroup` of such commands, one per action). A command
declares the flags it accepts as data (`src/commands/args.ts`) and its run step
maps validated arguments to a `CommandOutput`. It never prints, never chooses
between JSON and a listing, and cannot read a flag it did not declare.

`runCli` owns the rest: parsing, rejecting a flag the command did not declare
(this is why `cerebro sessions --keep 3` errors instead of being ignored),
coercing and validating the declared ones, opening and closing the database,
supplying the ambient clock and working directory (`now`/`cwd` on the command
input, injectable so a test can pin an instant), and rendering the result. A bad argument is a `CliError` thrown from wherever the rule
lives; runCli turns it into one message plus exit 1.

When adding a command: declare its options, return data, and add it to the
`commands` map plus the pinned option table in `test/cli.test.ts`. When adding a
flag to an existing command, declare it on that command only. Reach for a new
option builder in `args.ts` rather than validating inside a run step.

The `digest run` / `digest drain` pipeline (`src/digest/run.ts`) is the one place
cerebro spawns a model. It sits behind the `Summarizer` seam: `claudeSummarizer`
spawns the CLI, tests pass a fake. cerebro owns the prompt, the size tiering and
the storage guard, and never summarizes on its own initiative; the hooks decide
when. `CEREBRO_CLAUDE_BIN` overrides the binary.

## Invariants you must not break

These are load-bearing. Violating one silently corrupts the archive.

1. **Byte cursor stops at the last `\n`.** `splitBuffer` only advances past a
   complete line (or a final line that `JSON.parse`s). A half-written last line is
   left for the next run. `\n` (0x0A) never appears inside a UTF-8 multibyte
   sequence, so splitting the byte buffer on newline is safe.
2. **`splitBuffer` is shared by `runIndex` and `dryRunIndex`.** They must agree
   exactly on what counts as indexable, so the dry-run numbers match a real run.
   Keep the parsing logic in that one function.
3. **Index oldest-first** (`discoverSessionFiles` sorts by mtime asc, tiebreak
   sessionId). An original session must be indexed before any resume that branches
   from it, or a shared message is attributed to the resume.
4. **Dedup on message UUID**, not on file or session id. Normal runs use
   `INSERT OR IGNORE`; `--rebuild` upserts on the same UUID key, refreshing the
   payload (text, ts, role) but never `session_id`, so attribution stays with the
   first owner. This is what makes re-indexing, `--full`, and `--rebuild`
   idempotent. Never key dedup on anything else, and never delete rows during a
   rebuild: for sessions whose source file is gone, the archive is the only copy.
5. **Filter to `user` / `assistant` before dedup.** `classify` drops
   `file-history-snapshot`, `system`, etc. Some reuse other messages' UUIDs and
   would cause false collisions if inserted.
6. **Attribute messages to the file's owning session id**, not the line's. For a
   top-level file that is its filename UUID; for a subagent file it is the parent
   session (the enclosing `<uuid>` directory), so sidechains fold into the parent.
   `touchParentSession` refreshes the parent aggregate without clobbering its
   identity fields.
7. **`upsertSession` and `touchParentSession` stay two functions.** They write the
   same columns and look like duplication, but they differ in which operand wins
   each per-column `COALESCE`: a top-level file is the authority for its session
   (`COALESCE(excluded.x, sessions.x)`), while a subagent file must never clobber
   the parent (`COALESCE(sessions.x, excluded.x)`, with the fields it cannot know
   passed NULL). On top of that only `upsertSession` carries the title-priority
   `CASE` (a later `summary` must not overwrite a `custom-title`), while
   `touchParentSession` freezes `title_priority`. Merging them behind a
   `prefer: "incoming" | "existing"` flag is a decided non-goal: it hides the one
   thing that differs, and a wrong merge silently mis-attributes sessions
   (invariant #6).
8. **Use `cwd` from the line for the true path, never the decoded directory name.**
   The dash-encoding of project dirs is lossy when paths contain hyphens.
9. **git resolution must tolerate a missing directory** -> null, not a crash
   (`git.ts` already does; keep it cached per cwd).
10. **`bun:sqlite` `.changes` is inflated by the FTS trigger** (one insert reports
    ~7). Never trust its magnitude; measure `COUNT(*)` deltas for reporting.

## Data source

Top-level sessions: `~/.claude/projects/<encoded-path>/<session-uuid>.jsonl`.
Subagent transcripts: `<encoded-path>/<session-uuid>/subagents/agent-*.jsonl`
(`isSidechain: true`, their `sessionId` field is the parent). One JSONL line per
event, append-only.

Relevant fields: `type`, `uuid`, `parentUuid`, `timestamp`, `sessionId`, `cwd`,
`gitBranch`, `isSidechain`, `message.{role,content}` (string or block array).
Title events: `custom-title` (priority 3) > `ai-title` (2) > `summary` (1).

## Keep docs in sync

When you change a command, a flag, or its output, update both `README.md` and
`skills/cerebro/SKILL.md` (the skill is symlinked into `~/.claude/skills/cerebro`
and carries real example output, so refresh the examples too).

README is the user guide; the operational half lives in `docs/`, so a hook or
scheduling change belongs there rather than on the front page:

- `docs/hooks.md` - the `SessionEnd` (index + summarize on `/clear`) wiring, the
  deployed-binary rationale, and why cerebro ships no per-prompt injection hook.
- `docs/scheduling.md` - `digest-stale-batch.sh`, its env vars and lock, the launchd
  plist and the cron equivalent.
- `docs/digest-model-tiering.md` - the size-to-model tiering, its token budget, the
  `[1m]` suffix requirement and the `CEREBRO_DIGEST_*` overrides.

README keeps the command table as the single canonical list next to `src/help.ts`;
do not grow a competing one under `docs/`.
