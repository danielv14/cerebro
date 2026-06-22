# cerebro

A Bun + TypeScript CLI that indexes every Claude Code session JSONL into a local
SQLite archive and makes it searchable, incrementally and verbatim. See `README.md`
for what it does, install, usage, and architecture. This file is for working on the
code.

## Stack

- Bun >= 1.1, `import { Database } from "bun:sqlite"` (synchronous API). One small
  pure-JS runtime dependency (`stopword`, for relevance stopword filtering);
  otherwise dev deps are types only. Do not add native or network deps.
- TypeScript strict, `moduleResolution: bundler`, `.ts` extensions in imports.
- Code style follows the global conventions (const arrow functions, async/await,
  no em dashes in output). Commits in English.

## Developing and testing

- Typecheck: `bun run typecheck` (must stay green before you finish).
- Tests: `bun test`. The suite under `test/` runs against an in-memory SQLite DB
  (`:memory:`) plus temp fixture session files pointed at by `CEREBRO_CLAUDE_DIR`;
  helpers live in `test/fixtures.ts`. It covers the critical paths: byte/cursor
  splitting, dedup + incremental indexing, subagent folding, thread relinking,
  dry-run parity, CLI dispatch (`test/cli.test.ts`: arg validation + each command
  via an injected db and capturing sink), the digest layer (staleness, model
  tiering), and every query function. Add tests when you touch these.
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
4. **Dedup on message UUID via `INSERT OR IGNORE`**, not on file or session id. This
   is what makes re-indexing and `--full` idempotent. Never key dedup on anything
   else.
5. **Filter to `user` / `assistant` before dedup.** `classify` drops
   `file-history-snapshot`, `system`, etc. Some reuse other messages' UUIDs and
   would cause false collisions if inserted.
6. **Attribute messages to the file's owning session id**, not the line's. For a
   top-level file that is its filename UUID; for a subagent file it is the parent
   session (the enclosing `<uuid>` directory), so sidechains fold into the parent.
   `touchParentSession` refreshes the parent aggregate without clobbering its
   identity fields.
7. **Use `cwd` from the line for the true path, never the decoded directory name.**
   The dash-encoding of project dirs is lossy when paths contain hyphens.
8. **git resolution must tolerate a missing directory** -> null, not a crash
   (`git.ts` already does; keep it cached per cwd).
9. **`bun:sqlite` `.changes` is inflated by the FTS trigger** (one insert reports
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
