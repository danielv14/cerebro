# Digest model tiering

How cerebro picks the model that summarizes a thread, and the token budget the
threshold comes from. Relevant when tuning `CEREBRO_DIGEST_*` or debugging a
"Prompt is too long" failure. See [hooks.md](hooks.md) for the hook that calls this
and [scheduling.md](scheduling.md) for the scheduled catch-up job.

The summary model is chosen by transcript size, since the model's context window
is the real constraint. Small threads (the common case) use `claude-haiku-4-5`:
summarizing is mechanical compress-and-tag work, and Haiku is the cheapest model
with no extended-thinking overhead. Oversized threads escalate to
`claude-sonnet-4-6[1m]` in a single call: Sonnet has a 1M-token context window at
a flat $3/$15 per million tokens (no long-context surcharge), so a 400-600k-token
thread is summarized whole rather than cut short or summarized in pieces.

The `[1m]` suffix is required: it is how Claude Code selects the 1M-context
variant. Plain `claude-sonnet-4-6` gets the default 200k window, and a giant
thread still fails with "Prompt is too long".

cerebro makes the choice itself: `digest run` and `digest drain` measure the
transcript where they render it and choose on that, and `cerebro digest model`
exposes the same decision for manual inspection (`--bytes <n>` decides from an
already-measured size, `<id>` renders and measures). The decision is made on the
rendered transcript's byte size (the same size-bounded render `cerebro digest
input` prints; see "Curated summaries" in the [README](../README.md)), which is
capped so that even the largest thread cannot overflow the 1M context.

The threshold comes from a token budget, not the raw window size: `claude -p`
prepends its own system prompt and tool definitions (~77k tokens measured), so
the default reserves 90k tokens of the small model's 200k window and treats the
rest (about 330k bytes at 3 bytes per token) as the transcript budget. Override
via `CEREBRO_DIGEST_MODEL` (small model, default Haiku),
`CEREBRO_DIGEST_MODEL_LARGE` (large model, default `claude-sonnet-4-6[1m]`), and
`CEREBRO_DIGEST_HAIKU_MAX_CHARS` (escalation threshold, default 330000) in the
hook's environment.

Each model call also carries a timeout: a hung `claude -p` would otherwise hang
`digest run` (and every drain behind it) forever. After
`CEREBRO_DIGEST_TIMEOUT_MS` (default 600000, ten minutes) the child is killed
and the call is reported as an ordinary failure, so the thread stays stale and
the next drain retries it. The default is generous on purpose: a large thread
on the big model legitimately takes minutes.
