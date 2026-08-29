# Hooks (auto-index on /clear)

Wiring cerebro into Claude Code: the one hook it ships, what it does, and why it runs
a compiled binary. Kept out of the README so a flag change does not mean editing
around a JSON block. See also [scheduling.md](scheduling.md) for the scheduled
catch-up job and [digest-model-tiering.md](digest-model-tiering.md) for how the
summary model is picked.

cerebro only runs when asked, so one Claude Code hook keeps it current without a
background process: it re-indexes when you clear a session. (Claude Code deletes
session files after `cleanupPeriodDays`, default 30; raise it in
`~/.claude/settings.json` and index before then.)

Deploy a standalone binary so the hook starts fast (no `bun` spawn per event) and runs
even where `bun` is not on `PATH`:

```sh
bun run deploy   # builds dist/cerebro, copies it + the hook scripts (summarize-on-clear.sh, digest-stale-batch.sh) into $CLAUDE_CONFIG_DIR/cerebro (default ~/.claude/cerebro)
```

The binary is a frozen snapshot of the source. The PATH symlink (`~/.local/bin/cerebro`)
tracks the repo live, but the hook runs this compiled copy, so a code
change (or a digest-prompt change) does not reach the automated path until you re-run
`bun run deploy`.

## Index + summarize on /clear

A `SessionEnd` hook with `matcher: "clear"` runs `summarize-on-clear.sh` the moment you
clear a session. It indexes first, while the hook waits, so it captures the just-finished
session immediately, and then starts `cerebro digest run --stdin` in the background,
so `/clear` is never blocked by the model call. The script pipes the SessionEnd payload
straight through: cerebro pulls the session id out of it and runs the whole summarize
sequence itself (render the transcript, pick the model, call it, check the output,
store it). In `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      { "matcher": "clear", "hooks": [ { "type": "command", "command": "~/.claude/cerebro/summarize-on-clear.sh", "timeout": 120 } ] }
    ]
  }
}
```

`cerebro index` is incremental, so it only reads changed files; the next index catches
anything not yet written to disk. The background summary is best-effort: if it dies
(no auth, rate limit, killed on teardown), nothing is stored and `cerebro digest drain`
retries the thread on its next run. To index
on /clear without auto-summarizing, point the hook at `~/.claude/cerebro/cerebro index`
instead.

The background summary spawns `claude -p --no-session-persistence` (override the binary
with `CEREBRO_CLAUDE_BIN`), so the summarization
call itself never writes a transcript into `~/.claude/projects` for the indexer to pick
up as a bogus session. As a backstop the indexer also skips any transcript whose first
turn is the digest prompt, so even a digest run that predates this (or one written some
other way) never enters the archive.

## Why there is no per-prompt injection hook

Recall is on demand. `cerebro relevant <prompt>` and `cerebro recent` are commands the
`cerebro` skill runs when a question is worth answering from past work; nothing injects
past threads into a conversation on its own.

cerebro used to ship a `UserPromptSubmit` hook that ran `relevant --stdin --context` on
every prompt. It was removed because it did not pay for the context it cost. Three
measurements, taken on a 540-thread archive:

- **It never stayed quiet.** 119 real prompts replayed through it produced 119 blocks
  and zero silent runs. `relevantThreads` has no score floor, so it fills to `--limit`
  from whatever bm25 returns: 14 of 15 contentless prompts (`hmm`, `ok do it`,
  `commit and push`) got a full five rows.
- **The cost accumulated.** Claude Code stores hook stdout as a transcript attachment,
  so each block stayed in the conversation for the rest of the session. At ~434 tokens
  a block that was ~1.7k tokens per session at the median and ~18.7k at the 99th
  percentile, with 44% of rows repeating a thread already shown earlier in the
  same session.
- **Nothing followed the breadcrumbs.** Every measured recall event over two months
  started from the skill, not from an injected block.

Moving it to `SessionStart` does not help either: that payload has no `prompt`, so
relevance would come from cwd alone, which is `cerebro recent` under another name. And
standing context belongs in the system prompt rather than the first conversation turn,
which no hook event can write to.

`relevant` still accepts `--context` and `--stdin`, so the block can be wired into a
hook by hand. Nothing in cerebro does it for you.
