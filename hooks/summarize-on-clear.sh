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
# inner command resolves the prompt from cerebro (the single source of the
# contract) and writes the model's output straight back.
# Haiku is pinned deliberately: summarization is mechanical (compress + tag), it
# fires on every /clear (cheapest input price), and Haiku has no effort/thinking
# knobs to inherit from the user's settings and slow the background job down.
# Upgrade to claude-sonnet-4-6 here if summaries start missing nuance.
nohup bash -c '
  cerebro_bin="$1"; sid="$2"; log="$3"; model="$4"
  {
    date "+[digest %F %T] summarizing $sid"
    "$cerebro_bin" show "$sid" --full \
      | claude -p --model "$model" "$("$cerebro_bin" digest prompt)" \
      | "$cerebro_bin" digest write "$sid" --model "$model"
  } >> "$log/digest.log" 2>&1
' _ "$CEREBRO" "$session_id" "$LOG_DIR" "${CEREBRO_DIGEST_MODEL:-claude-haiku-4-5}" >> "$LOG_DIR/digest.log" 2>&1 </dev/null &

disown 2>/dev/null || true
exit 0
