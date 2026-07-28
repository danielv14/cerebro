# Scheduling the digest reconciler

The scheduled job that drains the summary backlog, and how to run it on macOS
(launchd) or Linux (cron). See [hooks.md](hooks.md) for the per-event hooks and
[digest-model-tiering.md](digest-model-tiering.md) for the model each run picks.

The `/clear` hook only summarizes the one session you just cleared, so every session
that ends another way (headless `claude -p`, abandoned, still open) never gets a summary
on its own. `digest-stale-batch.sh` is the reconciler that closes that gap: it indexes,
then runs `cerebro digest drain --limit $CEREBRO_DIGEST_BATCH_CAP` (default 8), which
summarizes that many stale threads newest first through the same pipeline and size
tiering the `/clear` hook uses. The script itself owns only the scheduling concerns: a
`mkdir` lock so two runs never overlap, a pinned PATH for launchd, and the log. A thread
that fails is left for the next run and never aborts the current one. Draining the backlog is a performance measure as much as tidiness: every thread
that gains a summary is one more prompt that `relevant` can answer from the cheap
summary tier instead of the raw-transcript scan (see "Curated summaries" in the
[README](../README.md)). Cap the
per-run count so a large backlog drains over several runs instead of one token burst;
raise the cap (or run it by hand) to drain faster:

```sh
CEREBRO_DIGEST_BATCH_CAP=400 ~/.claude/cerebro/digest-stale-batch.sh   # one-shot full drain
```

Schedule it however you like. On macOS, a `launchd` agent every 6 hours keeps the
backlog near zero. The plist is machine-specific (absolute paths; launchd does not
expand `~` or `$HOME`), so it is not checked in; create
`~/Library/LaunchAgents/com.<you>.cerebro.digest-stale.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.you.cerebro.digest-stale</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/YOU/.claude/cerebro/digest-stale-batch.sh</string>
  </array>
  <!-- Fixed clock times, not StartInterval: on a laptop that sleeps, StartInterval
       coalesces missed runs into one burst on wake. -->
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>0</integer><key>Minute</key><integer>17</integer></dict>
    <dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>17</integer></dict>
    <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>17</integer></dict>
    <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>17</integer></dict>
  </array>
  <!-- launchd starts with a bare environment; claude and cerebro are native binaries
       but still need a sane PATH. -->
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/Users/YOU/.local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>StandardOutPath</key><string>/Users/YOU/.claude/cerebro/digest-stale.launchd.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/.claude/cerebro/digest-stale.launchd.log</string>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.you.cerebro.digest-stale.plist   # load
launchctl kickstart -k gui/$(id -u)/com.you.cerebro.digest-stale                              # run now
launchctl bootout   gui/$(id -u) ~/Library/LaunchAgents/com.you.cerebro.digest-stale.plist   # unload
```

Progress lands in `digest.log` (lines prefixed `[stale ...]`). A plain `cron` entry that
runs the same script works just as well on Linux.
