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
# rendering contract), asks cerebro which model to use, and writes the output back.
#
# `cerebro digest model <id>` owns the size -> model tiering (cerebro is the single
# source of truth; the hook no longer hardcodes the threshold). The rationale: the
# context window is the real constraint and pricing rewards it. Small threads (the
# common case) -> Haiku 4.5 (200k context, cheapest, mechanical compress+tag job
# that fires on every /clear). Oversized threads -> Sonnet 4.6 [1m] in a single
# shot (1M context at a flat price, so a half-million-token thread fits whole
# without map-reduce); the "[1m]" suffix is how Claude Code selects the 1M variant,
# without it a giant thread still fails with "Prompt is too long". The same env
# vars still override the choice (CEREBRO_DIGEST_MODEL, CEREBRO_DIGEST_MODEL_LARGE,
# CEREBRO_DIGEST_HAIKU_MAX_CHARS); they are now read by `digest model`, and the
# child cerebro process inherits them from this hook's environment.
#
# The model output is captured to a file and only written back if claude -p
# succeeds (exit 0) and produced non-empty output. Piping claude straight into
# `digest write` would store whatever claude printed even on failure: a past run
# stored a "Prompt is too long" error as the summary that way. On failure we log
# and leave the thread unsummarized; `cerebro digest stale` retries it next time.
nohup bash -c '
  cerebro_bin="$1"; sid="$2"; log="$3"
  {
    date "+[digest %F %T] summarizing $sid"
    tmp="$(mktemp)"
    out="$(mktemp)"
    "$cerebro_bin" digest input "$sid" > "$tmp"
    model="$("$cerebro_bin" digest model "$sid")"
    echo "[digest] $sid: $(wc -c < "$tmp" | tr -d " ") chars -> $model"
    claude -p --model "$model" "$("$cerebro_bin" digest prompt)" < "$tmp" > "$out"
    rc=$?
    if [ "$rc" -eq 0 ] && [ -s "$out" ]; then
      "$cerebro_bin" digest write "$sid" --model "$model" < "$out"
    else
      echo "[digest] $sid: summary failed (claude exit $rc, $(wc -c < "$out" | tr -d " ") bytes) — left unsummarized; digest stale will retry"
    fi
    rm -f "$tmp" "$out"
  } >> "$log/digest.log" 2>&1
' _ "$CEREBRO" "$session_id" "$LOG_DIR" >> "$LOG_DIR/digest.log" 2>&1 </dev/null &

disown 2>/dev/null || true
exit 0
