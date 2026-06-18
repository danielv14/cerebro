#!/usr/bin/env bash
# cerebro: index on /clear, then summarize the just-cleared session in the
# background. Wired as a Claude Code SessionEnd hook with matcher "clear".
#
# Design:
# - The index runs synchronously (incremental, fast) so /clear captures the
#   session into the archive immediately.
# - The summary runs detached, so /clear is never blocked by an LLM call. cerebro
#   itself never calls an LLM; this script pipes the transcript through `claude -p`
#   out of band and writes the result back with `cerebro digest write`.
# - It is best-effort. If the detached job dies (no auth, rate limit, killed on
#   session teardown), nothing is lost: `cerebro digest stale` is the reconciler
#   and re-surfaces the thread on the next run.
# - It targets only the cleared session id, so headless `claude -p` sessions
#   (which are never /cleared) never trigger summaries of themselves.
set -uo pipefail

CEREBRO="${CEREBRO_BIN:-$HOME/.claude/cerebro/cerebro}"
LOG_DIR="$(dirname "$CEREBRO")"

# SessionEnd delivers a JSON payload on stdin; capture it before anything reads it.
payload="$(cat)"

# Let the final lines flush, then index synchronously.
sleep 0.5
{ date "+[clear-hook %F %T]"; "$CEREBRO" index; } >> "$LOG_DIR/index.log" 2>&1

# Pull the session id out of the payload without depending on jq being installed.
session_id="$(printf '%s' "$payload" \
  | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  | head -n1)"

# Nothing to summarize without an id, or if the claude CLI is not on PATH.
[ -n "$session_id" ] || exit 0
command -v claude >/dev/null 2>&1 || exit 0

# Detached summary: nohup + closed stdio so it outlives the /clear teardown. The
# inner command renders the size-bounded transcript from cerebro (which owns the
# rendering contract), picks a model by its size, and writes the output straight
# back.
#
# Model is tiered by transcript size, because the context window is the real
# constraint and pricing rewards it:
# - Small threads (the common case) -> Haiku 4.5 (200k context, $1/$5 per MTok).
#   Summarization is mechanical (compress + tag), it fires on every /clear, and
#   Haiku is cheapest with no effort/thinking knobs to slow the background job.
# - Oversized threads (200k-1M tokens) -> Sonnet 4.6 in a single shot. Sonnet has
#   a 1M-token context at a flat $3/$15 per MTok (no long-context premium), so a
#   half-million-token thread fits whole without truncation or map-reduce. The
#   escalation costs more per event but only fires on the rare giant thread.
#   The "[1m]" suffix is required: it is how Claude Code selects the 1M-context
#   variant. Plain "claude-sonnet-4-6" gets the default 200k window and a giant
#   thread still fails with "Prompt is too long" -- the suffix is the whole point.
# The threshold is a char proxy (cerebro has no tokenizer): ~540k chars is a
# conservative stand-in for ~180k tokens, escalating before Haiku's 200k can
# overflow. `cerebro digest input` water-fill-caps anything above ~2.7M chars, so
# even Sonnet's 1M context is never exceeded. Override any of the three via env.
#
# The model output is captured to a file and only written back if claude -p
# succeeds (exit 0) and produced non-empty output. Piping claude straight into
# `digest write` would store whatever claude printed even on failure: a past run
# stored a "Prompt is too long" error as the summary that way. On failure we log
# and leave the thread unsummarized; `cerebro digest stale` retries it next time.
nohup bash -c '
  cerebro_bin="$1"; sid="$2"; log="$3"; small="$4"; large="$5"; threshold="$6"
  {
    date "+[digest %F %T] summarizing $sid"
    tmp="$(mktemp)"
    out="$(mktemp)"
    "$cerebro_bin" digest input "$sid" > "$tmp"
    chars="$(wc -c < "$tmp")"
    if (( chars > threshold )); then model="$large"; else model="$small"; fi
    echo "[digest] $sid: $chars chars -> $model"
    claude -p --model "$model" "$("$cerebro_bin" digest prompt)" < "$tmp" > "$out"
    rc=$?
    if [ "$rc" -eq 0 ] && [ -s "$out" ]; then
      "$cerebro_bin" digest write "$sid" --model "$model" < "$out"
    else
      echo "[digest] $sid: summary failed (claude exit $rc, $(wc -c < "$out" | tr -d " ") bytes) — left unsummarized; digest stale will retry"
    fi
    rm -f "$tmp" "$out"
  } >> "$log/digest.log" 2>&1
' _ "$CEREBRO" "$session_id" "$LOG_DIR" \
  "${CEREBRO_DIGEST_MODEL:-claude-haiku-4-5}" \
  "${CEREBRO_DIGEST_MODEL_LARGE:-claude-sonnet-4-6[1m]}" \
  "${CEREBRO_DIGEST_HAIKU_MAX_CHARS:-540000}" >> "$LOG_DIR/digest.log" 2>&1 </dev/null &

disown 2>/dev/null || true
exit 0
