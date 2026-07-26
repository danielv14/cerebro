# Hooks (auto-index + context injection)

Wiring cerebro into Claude Code: the two hooks, what each does, and why they run
a compiled binary. Moved out of README so a flag change does not mean editing
around a JSON block. See also [scheduling.md](scheduling.md) for the reconciler and
[digest-model-tiering.md](digest-model-tiering.md) for how the summary model is picked.

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

## Index + summarize on /clear

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

## Relevant past threads per prompt

`cerebro recent` lists recent threads for a repo and `cerebro relevant <prompt>`
returns the threads most relevant to a prompt (FTS, bm25, recency-decayed: within
each tier the bm25 score decays with the thread's age at a 90-day half-life, so an
equal text match prefers recent work; plain `search` stays pure bm25). `relevant`
matches the curated summaries first (high signal) and falls back to raw-transcript
bm25 for threads not yet summarized; a snippet labelled `summary:` came from the summary,
`match:` from the transcript. Both surface compact, recognizable breadcrumbs (id,
date, title, the opening prompt, and for `relevant` a matching snippet), index-first
so the model pulls detail on demand with `show` / `search`. `--context` emits an
agent-facing block (silent when nothing matches); `--stdin` reads the prompt (and the
cwd) from a hook's JSON payload.

Ranking also knows which repo you are in: threads from the cwd's repo (its git root,
else the exact project path) get their score multiplied by 1.5 in both tiers, roughly
worth two months of recency, since a prompt typed in repo X usually relates to past
work in repo X. It is a boost, never a filter, so a much stronger match in another
repo still surfaces, which matters for shared-infrastructure work. The cwd comes from
the hook payload under `--stdin`, or from `--cwd <path>` manually; with neither,
ranking is global as before.

The two tiers differ in cost, so summary coverage is what keeps this fast: an
unsummarized archive falls through to the raw tier and pays its full-index scan on every
prompt (386 ms on a 300 000-message archive with no summaries, see "Curated summaries"
in the [README](../README.md)). Keep the backlog drained with the scheduled reconciler
(`digest-stale-batch.sh`, see [scheduling.md](scheduling.md)) and most prompts never
reach the raw tier at all.

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
