# Digest model tiering

How cerebro picks the model that summarizes a thread, and the token budget the
threshold is derived from. Relevant when tuning `CEREBRO_DIGEST_*` or debugging a
"Prompt is too long" failure. See [hooks.md](hooks.md) for the hook that calls this
and [scheduling.md](scheduling.md) for the batch reconciler.

The summary model is tiered by transcript size, since the model context window is the
real constraint. Small threads (the common case) use `claude-haiku-4-5` (mechanical
compress-and-tag work, cheapest input price, no effort/thinking overhead). Oversized
threads escalate to `claude-sonnet-4-6[1m]` in a single shot: Sonnet has a 1M-token
context at a flat $3/$15 per MTok (no long-context premium), so a 400-600k-token thread
is summarized whole rather than truncated or map-reduced. The `[1m]` suffix is required:
it is how Claude Code selects the 1M-context variant; plain `claude-sonnet-4-6` gets the
default 200k window and a giant thread still fails with "Prompt is too long". cerebro
owns the tiering: the hook asks `cerebro digest model` (passing `--bytes <n>`, the size
of the `digest input` it already rendered, so the transcript is not rendered twice;
`digest model <id>` renders and measures for manual use), which decides by the rendered
transcript's byte size (`cerebro digest input` is the size-bounded transcript; see
"Curated summaries" in the [README](../README.md)), and `cerebro digest input`
water-fill-caps anything large enough to risk overflowing even a 1M context. The
threshold is derived from a token budget, not the raw window: `claude -p` prepends its
own system prompt and tool definitions (~77k tokens measured), so the default reserves
90k tokens of the small model's 200k window and treats the rest (≈330k bytes at 3
bytes/token) as the transcript budget. Override the tier via `CEREBRO_DIGEST_MODEL`
(small, default Haiku), `CEREBRO_DIGEST_MODEL_LARGE` (large, default
`claude-sonnet-4-6[1m]`), and `CEREBRO_DIGEST_HAIKU_MAX_CHARS` (escalation threshold,
default 330000) in the hook's environment.
