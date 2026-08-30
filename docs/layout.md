# Source layout

The map of the source tree, one line per module.
[architecture.md](architecture.md) covers how these fit together and why they
are shaped the way they are; this file is the inventory.

```
src/
  cli.ts        parseArgs + the dispatch table + option checking + db lifetime
                + the ambient clock/cwd + rendering (a command returns data;
                runCli prints it)
  help.ts       the HELP text
  commands/     one module per command: its declared options, its run step, and
                its output formatting
    args.ts     options as data (flag/text/numeric/isoDate/choice/range) + CliError
    command.ts  defineCommand + defineDbLessCommand, CommandContext/
                CommandInput/CommandOutput, the group shape
    helpers.ts  readStdin() + resolveSession()/resolveOrThrow()
  db.ts         openDb() + schema/migrations + dbFileSize()
  paths.ts      cerebro's own home paths (claudeDir, defaultDbPath,
                deployedBinaryPath)
  sources/      the source-adapter seam (see source-adapters.md):
    adapter.ts    SessionFile + Classified + the SourceAdapter contract
    claude-code.ts  the Claude Code source: projects-dir discovery
    registry.ts   the adapter list + the global oldest-first file merge
  jsonl.ts      classify() + flattenContent(): the Claude Code JSONL grammar
  git.ts        createGitResolver(): the GitResolver seam, spawning git behind a
                per-instance cwd cache
  scan.ts       the source-file scan layer: splitBuffer(), planFileRead(),
                eachIndexableFile(), orphanedCursorPaths()
  indexer.ts    runIndex() + dryRunIndex() (ingest, session rows, presence
                reconciliation)
  thread.ts     what a thread is, end to end: the threads view DDL + row shape,
                rootOf(), threadMessages(), listThreads(), recentThreads(),
                attachThreadDisplay(), relinkThreads()
  fts.ts        the message-FTS layer: rankedMessageHits(), dedupedHitWindow()
                (fetch + dedup + growth), escapeLike(), toMatchQuery()
  search.ts     search(): the search command's filters, first-window sizing and
                fallback policy
  stats.ts      stats() + archiveSpan()
  relevance.ts  relevantThreads() + the ranking weights (recency decay, same-repo
                boost)
  skills.ts     skillUsage(): the two skill-call markers and the counting rules
                (roles, occurrences, subagent turns)
  render.ts     shared formatting primitives (shortId, shortTime, oneLine, ...)
  digest/       DIGEST_PROMPT + model tiering (prompt.ts), the env-resolved
                DigestConfig (config.ts), staleThreads() + summaryCoverage()
                (stale.ts), writeSummary() + the summary full-text search
                (store.ts), the summarize pipeline + the Summarizer seam (run.ts)
  digest-signature.ts  the prompt's opening sentence (leaf; the indexer keys
                digest-transcript skipping on it)
  backup.ts     runBackup() (VACUUM INTO snapshots + pruning)
test/
  *.test.ts     bun test suite + fixtures.ts (temp claude dir + sessions);
                per-command formatting tests under test/commands/
```

## Dependencies

Built on Bun (`bun:sqlite`, synchronous, no native or network deps). Two small
pure-JS dependencies: `stopword` filters filler words out of relevance queries,
and `valibot` validates the untrusted input boundaries (the session JSONL and
the two hook stdin payloads). Ranked search comes from SQLite FTS5 full-text
indexes over the messages and summaries.
