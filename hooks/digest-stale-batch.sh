#!/usr/bin/env bash
# cerebro: drain the digest backlog. Indexes, then hands up to CAP stale threads
# to `cerebro digest drain`, which summarizes each one and writes it back.
#
# This is the reconciler that summarize-on-clear.sh assumes exists. The clear hook
# only summarizes the one just-cleared session, so every session that ends without
# /clear (headless, abandoned, still-open) accrues as backlog. This agent drains
# that backlog gradually. Wired as a launchd agent that runs every 6 hours.
#
# Token safety: CAP bounds how many threads one run summarizes, so a large backlog
# drains over several runs instead of one burst. A lock prevents overlapping runs.
# Newest-first ordering means recent sessions (most likely to be recalled) are
# summarized first; the older tail drains over subsequent runs.
set -uo pipefail

# launchd gives a bare environment. claude and cerebro are native binaries, but we
# still pin a sane PATH so both resolve: cerebro spawns claude by name.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

CEREBRO="${CEREBRO_BIN:-$HOME/.claude/cerebro/cerebro}"
LOG_DIR="$(dirname "$CEREBRO")"
LOG="$LOG_DIR/digest.log"
CAP="${CEREBRO_DIGEST_BATCH_CAP:-8}"
LOCK="$LOG_DIR/digest-stale.lock"
# A lock older than this cannot belong to a live run (mkdir plus the cleanup traps
# would have removed it), so it is the residue of a hard kill: SIGKILL, power loss,
# or a launchd teardown before the trap fired. Break it instead of wedging the
# reconciler forever. The default is far longer than any scheduled CAP run and
# shorter than the 6h cadence, so a dead lock self-heals within a cycle. Raise it for
# a long manual drain (CEREBRO_DIGEST_BATCH_CAP=400) that may run past the default.
LOCK_STALE_MIN="${CEREBRO_DIGEST_LOCK_STALE_MIN:-180}"

log() { printf '%s %s\n' "$(date '+[stale %F %T]')" "$*" >> "$LOG"; }

# Break a stale lock left behind by a dead run before trying to acquire it. find
# -mmin +N behaves the same on BSD (macOS) and GNU; the lock dir's mtime is its
# creation time and never changes during a run, so it reads as the run's age.
if [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin "+$LOCK_STALE_MIN" 2>/dev/null)" ]; then
  log "breaking stale lock older than ${LOCK_STALE_MIN}m ($LOCK)"
  rmdir "$LOCK" 2>/dev/null || true
fi

# Single-flight: mkdir is atomic. If a live batch still holds the lock, bail quietly
# so two runs never summarize in parallel (double tokens, double work).
if ! mkdir "$LOCK" 2>/dev/null; then
  log "another batch holds the lock ($LOCK), skipping this run"
  exit 0
fi
# Clean up the lock on any exit. The INT/TERM trap turns a graceful launchd teardown
# or Ctrl-C into a normal exit so the EXIT trap runs; a hard SIGKILL still cannot be
# caught, which is what the staleness check above backstops.
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
trap 'exit' INT TERM

# Keep the archive fresh even between /clears: index synchronously first so newly
# written sessions become eligible for summarizing on this same run.
{ date "+[stale-hook %F %T]"; "$CEREBRO" index; } >> "$LOG_DIR/index.log" 2>&1

# Drain the backlog. `cerebro digest drain` owns the per-thread sequence (render,
# tier the model, call it, guard the output, store it), the newest-first ordering,
# and "one failed thread must not abort the run". This script owns only the things
# that belong to the shell: scheduling, the single-flight lock, PATH, and the log.
# The loop, the temp files and the `claude` invocation that used to live here are
# gone, along with the second copy of them in summarize-on-clear.sh.
{ date "+[stale %F %T]"; "$CEREBRO" digest drain --limit "$CAP"; } >> "$LOG" 2>&1

# Housekeeping while we already hold the single-flight lock: merge the FTS
# indexes' incremental b-trees, refresh planner stats, truncate the WAL.
"$CEREBRO" maintain >> "$LOG" 2>&1 || true
exit 0
