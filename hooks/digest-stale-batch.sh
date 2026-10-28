#!/usr/bin/env bash
# Cadence, env vars and the launchd plist: docs/scheduling.md.
set -uo pipefail

# launchd gives a bare environment. claude and cerebro are native binaries, but we
# still pin a sane PATH so both resolve: cerebro spawns claude by name.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

CEREBRO="${CEREBRO_BIN:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cerebro/cerebro}"
LOG_DIR="$(dirname "$CEREBRO")"
LOG="$LOG_DIR/digest.log"
CAP="${CEREBRO_DIGEST_BATCH_CAP:-8}"
LOCK="$LOG_DIR/digest-stale.lock"
# The default is far longer than any scheduled CAP run and shorter than the 6h
# cadence, so a dead lock self-heals within a cycle.
LOCK_STALE_MIN="${CEREBRO_DIGEST_LOCK_STALE_MIN:-180}"

log() { printf '%s %s\n' "$(date '+[stale %F %T]')" "$*" >> "$LOG"; }

# find -mmin +N behaves the same on BSD (macOS) and GNU; the lock dir's mtime is its
# creation time and never changes during a run, so it reads as the run's age.
is_stale() {
  [ -d "$1" ] && [ -n "$(find "$1" -maxdepth 0 -mmin "+$LOCK_STALE_MIN" 2>/dev/null)" ]
}

# Breaking runs under its own mutex and re-checks staleness inside it: two runs that both
# saw the stale lock would otherwise each remove it, the second removing the fresh lock
# the first had just taken. A break mutex left by a killed run would block every later
# break, so it ages out the same way.
is_stale "$LOCK.break" && rmdir "$LOCK.break" 2>/dev/null
if is_stale "$LOCK" && mkdir "$LOCK.break" 2>/dev/null; then
  if is_stale "$LOCK"; then
    log "breaking stale lock older than ${LOCK_STALE_MIN}m ($LOCK)"
    rm -rf "$LOCK"
  fi
  rmdir "$LOCK.break"
fi

if ! mkdir "$LOCK" 2>/dev/null; then
  log "another batch holds the lock ($LOCK), skipping this run"
  exit 0
fi
echo $$ > "$LOCK/owner"
# Only remove the lock this run owns: a run that outlived the staleness window has had its
# lock broken and retaken by another. A hard SIGKILL skips this trap, which is what the
# staleness check above backstops.
trap '[ "$(cat "$LOCK/owner" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK"' EXIT

{ date "+[stale-hook %F %T]"; "$CEREBRO" index; } >> "$LOG_DIR/index.log" 2>&1

# Each line is stamped as it arrives, not just the first: drain streams a line per
# thread as it completes, and a timestamp on every one is what makes a wedged
# overnight run readable.
"$CEREBRO" digest drain --limit "$CAP" 2>&1 |
  while IFS= read -r line; do log "$line"; done

"$CEREBRO" maintain 2>&1 | while IFS= read -r line; do log "$line"; done

# Truncate in place rather than mv, so the clear hook's detached summary, which may
# still hold digest.log open, keeps appending to the same file. A line the clear hook
# appends between tail and the rewrite is lost; the lock does not cover that hook.
for file in "$LOG_DIR/index.log" "$LOG"; do
  [ -s "$file" ] || continue
  trimmed="$(tail -n 5000 "$file")" && printf '%s\n' "$trimmed" > "$file"
done
exit 0
