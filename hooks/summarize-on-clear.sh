#!/usr/bin/env bash
# cerebro: index on /clear, then summarize the just-cleared session in the
# background. Wired as a Claude Code SessionEnd hook with matcher "clear".
#
# Design:
# - The index runs synchronously (incremental, fast) so /clear captures the
#   session into the archive immediately.
# - The summary runs detached, so /clear is never blocked by the model call.
# - `cerebro digest run` owns the whole summarize sequence: render the
#   size-bounded transcript, tier the model on its size, call the model, refuse
#   output that cannot be a summary, store it. This script decides only *when*
#   that happens and *where* its output is logged. Those rules used to live here
#   and in digest-stale-batch.sh as two copies of the same bash; they are one
#   tested code path now.
# - It is best-effort. If the detached job dies (no auth, rate limit, killed on
#   session teardown), nothing is lost: `cerebro digest drain` is the reconciler
#   and re-surfaces the thread on its next run.
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

# Detached summary: nohup so it outlives the /clear teardown. The payload is piped
# to `digest run --stdin`, which pulls the session id out of it with a validated
# JSON boundary. This script no longer sed-scrapes an id out of that JSON, and no
# longer renders, measures, tiers, or guards anything itself.
printf '%s' "$payload" | nohup bash -c '
  cerebro_bin="$1"; log="$2"
  { date "+[digest %F %T]"; "$cerebro_bin" digest run --stdin; } >> "$log/digest.log" 2>&1
' _ "$CEREBRO" "$LOG_DIR" >> "$LOG_DIR/digest.log" 2>&1 &

disown 2>/dev/null || true
exit 0
