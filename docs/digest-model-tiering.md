# Digest model tiering

How cerebro picks the model that summarizes a thread, and the token budget the
threshold comes from. Relevant when tuning `CEREBRO_DIGEST_*` or debugging a
"Prompt is too long" failure. See [hooks.md](hooks.md) for the hook that calls this
and [scheduling.md](scheduling.md) for the scheduled catch-up job.

cerebro picks the summary model by transcript size. Small threads (the common
case) use `claude-haiku-5-5`: summarizing is mechanical compress-and-tag work, and
Haiku is the cheapest model: $0.10/$0.50 per million tokens up to 100k tokens of
prompt, $0.50/$2.50 above. Threads above the threshold escalate to `claude-sonnet-5-5` ($2/$10) in a
single call, so a 400-600k-token thread is summarized whole by the stronger model
rather than cut short or summarized in pieces.

Both models have a 1M-token context window in `claude -p` without a `[1m]` suffix
(`--output-format json` reports `contextWindow: 1000000` for each). The threshold
is therefore not a context limit. It keeps the routing the old 200k Haiku 4.5
forced: about 330k bytes, roughly 150k tokens of transcript. Haiku 5.5 summarized a
351 KB thread fine, but on a ~1M-token thread it answered the transcript's last
turn instead of summarizing it, so larger threads still go to Sonnet.

`digest run` and `digest drain` measure the transcript where they render it and
choose on that. The input is the rendered transcript's byte size, which is capped
so that even the largest thread cannot overflow the 1M context. The threshold and
that cap are both byte counts, and a body that has to be trimmed is cut on a
character boundary, so a Swedish or CJK thread is measured in the same unit the
budget was derived in.

The cap comes from a token budget, not the raw window size. `claude -p` adds its
tool definitions and CLAUDE.md files to every call (~40k tokens measured on Claude
Code 2.1.294) and needs room for the response, so the cap reserves 100k tokens of
the 1M window. The rest is the transcript budget: about 1.8M bytes at 2 bytes per
token, where the 5.x tokenizer measured 2.1-2.4 on real transcripts.
Override via `CEREBRO_DIGEST_MODEL` (small model, default `claude-haiku-5-5`),
`CEREBRO_DIGEST_MODEL_LARGE` (large model, default `claude-sonnet-5-5`), and
`CEREBRO_DIGEST_HAIKU_MAX_CHARS` (escalation threshold in bytes, default 330000)
in the hook's environment. A large-model override with a 200k window, such as
plain `claude-sonnet-4-6`, needs the `[1m]` suffix to get the 1M variant, or a
giant thread fails with "Prompt is too long". A small-model override with a 200k
window, such as `claude-haiku-4-5`, also needs a lower threshold: 330000 bytes
can reach 165k tokens, which with the overhead overflows 200k.

Each model call also carries a timeout: a hung `claude -p` would otherwise hang
`digest run` (and every drain behind it) forever. After
`CEREBRO_DIGEST_TIMEOUT_MS` (default 600000, ten minutes) cerebro kills the child
and reports the call as an ordinary failure, so the thread stays stale and the
next drain retries it. The default is generous on purpose: a large thread on the
big model legitimately takes minutes.
