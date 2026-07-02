#!/usr/bin/env bash
# cerebro: drain the digest backlog. Indexes, then summarizes up to CAP stale
# threads per run through `claude -p`, writing each summary back.
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
# still pin a sane PATH so they (and mktemp/wc/etc) resolve.
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

command -v claude >/dev/null 2>&1 || { log "claude not on PATH — skipping"; exit 0; }

# Keep the archive fresh even between /clears: index synchronously first so newly
# written sessions become eligible for summarizing on this same run.
{ date "+[stale-hook %F %T]"; "$CEREBRO" index; } >> "$LOG_DIR/index.log" 2>&1

# Newest-first list of stale thread ids, capped. --ids is the machine-readable
# contract (one full id per line, no human formatting), so this never scrapes the
# listing layout; empty output means nothing is stale.
ids="$("$CEREBRO" digest stale --limit "$CAP" --ids 2>/dev/null)"
[ -n "$ids" ] || { log "nothing stale, backlog clean"; exit 0; }

count="$(printf '%s\n' "$ids" | grep -c .)"
log "draining up to CAP=$CAP: $count thread(s) this run"

done_n=0; failed=0
while IFS= read -r sid; do
  [ -n "$sid" ] || continue
  tmp="$(mktemp)"; out="$(mktemp)"

  "$CEREBRO" digest input "$sid" > "$tmp"
  # Tier on the transcript we just rendered (digest model --bytes) instead of
  # having `digest model <id>` render the whole thread a second time.
  bytes="$(wc -c < "$tmp" | tr -d ' ')"
  model="$("$CEREBRO" digest model --bytes "$bytes")"
  if [ -z "$model" ]; then
    log "$sid: could not resolve a model — skipped"
    rm -f "$tmp" "$out"; continue
  fi
  log "$sid: $bytes bytes -> $model"

  # Mirror summarize-on-clear.sh: --no-session-persistence so this one-shot is not
  # written into ~/.claude/projects and re-indexed as a bogus session. Only write
  # the summary back on success + non-empty output (never store an error string).
  claude -p --no-session-persistence --model "$model" "$("$CEREBRO" digest prompt)" < "$tmp" > "$out"
  rc=$?
  if [ "$rc" -eq 0 ] && [ -s "$out" ]; then
    "$CEREBRO" digest write "$sid" --model "$model" < "$out"
    done_n=$((done_n + 1))
  else
    log "$sid: summary failed (claude exit $rc, $(wc -c < "$out" | tr -d ' ') bytes) — left for next run"
    failed=$((failed + 1))
  fi
  rm -f "$tmp" "$out"
done <<< "$ids"

log "run complete: $done_n summarized, $failed failed"
exit 0
