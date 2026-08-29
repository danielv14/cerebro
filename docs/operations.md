# Operations

Keeping the archive healthy: backups, restore, housekeeping and the health
report. See [hooks.md](hooks.md) and [scheduling.md](scheduling.md) for the
automation that keeps the archive current, and
[architecture.md](architecture.md) for why `doctor` reports rather than repairs.

## Backups

For sessions whose source files Claude Code has already deleted, the archive is
the only copy, so back it up. `cerebro backup` snapshots the database into a
single compact file at `<db-dir>/backups/archive-<timestamp>.sqlite`. It uses
`VACUUM INTO`, which is safe to run while another process writes to the
database. `--to <path>` picks an explicit target, and `--keep N` deletes the
oldest default-named backups beyond N.

A natural place to hang it is the scheduled digest batch, e.g. append
`~/.claude/cerebro/cerebro backup --keep 8` to `digest-stale-batch.sh`'s
schedule or run it from the same launchd/cron entry.

To restore one, stop whatever writes to the archive first (disable the hook or
the launchd agent), then:

```sh
cp ~/.claude/cerebro/backups/archive-<timestamp>.sqlite ~/.claude/cerebro/archive.sqlite
rm -f ~/.claude/cerebro/archive.sqlite-wal ~/.claude/cerebro/archive.sqlite-shm
cerebro index      # catch up on everything written since the snapshot
cerebro doctor     # confirm integrity and schema before re-enabling the hook
```

Deleting the stale `-wal` / `-shm` files matters: they are SQLite working files
that belong to the replaced database, and SQLite would otherwise try to replay
them onto the snapshot.

## Housekeeping

`cerebro maintain` compacts the search indexes, refreshes SQLite's internal
statistics, and trims the working files. The scheduled digest batch runs it
automatically at the end of each run, so you rarely need it by hand.

## Health checks

`cerebro doctor` is one read-only report over everything that can quietly go
wrong. It checks database and search-index integrity, the schema version,
leftover index state, sessions with no messages, oversized working files,
summary coverage and staleness, whether the deployed binary is out of date with
the repo, and whether the hook is wired in `settings.json` at all. It never
repairs anything; each finding names the command that does.

```sh
cerebro doctor            # quick integrity check, the everyday form
cerebro doctor --full     # the thorough integrity check (slower on a large archive)
cerebro doctor --json     # the same checks as structured rows
```

The exit code is 1 only on a hard failure (corruption, or a database schema this
build does not understand), so it works as a cron or CI guard without going red
on a warning like a summary backlog.

`cerebro version` prints the build identity on its own, which is what makes the
out-of-date check possible: a binary built from source reports itself as unbuilt
rather than claiming a commit it does not have. The deployed binary is a frozen
snapshot, so a code change does not reach the hook or the scheduled job until
`bun run deploy` (see [hooks.md](hooks.md)).
