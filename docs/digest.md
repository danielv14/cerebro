# Working with summaries

How to produce and use the curated summaries, and what they buy. The verb list
is in the [README](../README.md); this is the workflow behind it. See
[digest-model-tiering.md](digest-model-tiering.md) for the size-to-model
tiering, [architecture.md](architecture.md) for the design of the digest
package, and [scheduling.md](scheduling.md) for the job that works the backlog
off unattended.

## Summaries make `relevant` faster

`relevant` only falls back to scanning raw transcripts when the summaries come
up short of `--limit`. That raw scan is the expensive part: it touches one row
per message, where the summary scan touches one row per thread. Measured with
the compiled binary against a synthetic archive of 300 000 messages (1200
sessions, 148 MB) and no summaries at all, the worst case where every lookup
falls through to the raw scan:

```
cerebro relevant "<prose prompt>" --limit 5    386 ms
```

That is what a lookup costs on an archive with no summaries; it shrinks as more
threads get summarized. So draining the backlog is worth it for latency, not
only for coverage.

## The one-command route

`digest run` is the whole sequence in one command, and it is what the hooks
call:

```sh
cerebro digest run <id>              # one thread
cerebro digest drain --limit 8       # the stalest N, newest first
```

It spawns `claude -p --no-session-persistence` with the model the size tiering
picked, hands it the transcript on stdin, and stores the result only if the call
succeeded and the output looks like an actual summary rather than an error
message or a fragment. Nothing is stored on failure, so the thread stays stale
and the next `drain` retries it. `CEREBRO_CLAUDE_BIN` overrides which binary is
spawned.

## Driving the steps yourself

The individual verbs are still there when you want to drive them yourself, or
summarize inline as an agent without spawning anything:

```sh
cerebro digest input <id> | claude -p "$(cerebro digest prompt)" | cerebro digest write <id>
```

Pipe `digest input` rather than `show --full`: it renders the same transcript
but trimmed to fit a single model context, so a giant thread does not overflow
it. Either route keeps the contract in one place: the prompt asks for exactly
what `digest write` stores, and `digest stale` re-surfaces a thread whenever it
gains messages or the prompt version (`DIGEST_PROMPT_VERSION`) is bumped.

## Keeping coverage up

`digest drain` is the catch-up command, run now and then or on a schedule. The
summary fired on `/clear` is an optional fast path on top of it, never the
source of truth: sessions that end another way (headless `claude -p`, abandoned,
still open) only ever get a summary from a drain.
