#!/usr/bin/env bash
# cerebro's Claude Code SessionEnd hook (matcher "clear"). Indexes synchronously,
# then hands the payload to `cerebro digest run --stdin` detached. Wiring and
# rationale: docs/hooks.md.
set -uo pipefail

CEREBRO="${CEREBRO_BIN:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cerebro/cerebro}"
LOG_DIR="$(dirname "$CEREBRO")"

# SessionEnd delivers a JSON payload on stdin; capture it before anything reads it.
payload="$(cat)"

# Let the final lines flush, then index synchronously.
sleep 0.5
{ date "+[clear-hook %F %T]"; "$CEREBRO" index; } >> "$LOG_DIR/index.log" 2>&1

# nohup so the summary outlives the /clear teardown. The payload travels as an
# argument and is piped in *inside* the detached child, so no foreground process
# has to survive teardown for the session id to arrive.
nohup bash -c '
  cerebro_bin="$1"; log="$2"; payload="$3"
  {
    date "+[digest %F %T]"
    printf "%s" "$payload" | "$cerebro_bin" digest run --stdin
  } >> "$log/digest.log" 2>&1
' _ "$CEREBRO" "$LOG_DIR" "$payload" >> "$LOG_DIR/digest.log" 2>&1 </dev/null &

disown 2>/dev/null || true
exit 0
