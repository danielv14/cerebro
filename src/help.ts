export const HELP = `cerebro - permanent verbatim archive + search over Claude Code sessions

Usage:
  cerebro index [--full] [--rebuild] [--dry-run]   Index all sessions incrementally
  cerebro search <query> [--limit N] [--project P] [--since D] [--all]
                                         Full-text search (ranked, best hit per thread;
                                         --all for every matching message)
  cerebro sessions [--project P] [--limit N]   List threads, newest first
  cerebro recent [--cwd P] [--days D] [--limit N] [--context]   Recent threads for one repo
  cerebro relevant <prompt> [--limit N] [--context]   Past threads relevant to a prompt
  cerebro show <session-id> [--full] [--range A..B]
                                         Show a thread (outline, full transcript, or
                                         a verbatim slice in outline numbering)
  cerebro stats                          Archive counts
  cerebro backup [--to <path>] [--keep N]
                                         Snapshot the database (VACUUM INTO); default
                                         target <db-dir>/backups/archive-<ts>.sqlite
  cerebro maintain                       Optimize the FTS indexes, refresh planner
                                         stats, and truncate the WAL
  cerebro digest <action>                Curated session summaries (see below)

Digest actions:
  cerebro digest stale [--limit N] [--ids]    List threads needing a (re)summary
  cerebro digest prompt                       Print the summarization prompt
  cerebro digest input <id>                   Print the size-bounded transcript to summarize
  cerebro digest model <id> | --bytes N       Print the model the size tiering would pick
  cerebro digest write <id> [--model M]       Store a summary for a thread (reads it from stdin)
  cerebro digest search <query> [--limit N]   Full-text search the summaries
  cerebro digest show <id>                    Print a thread's stored summary

  cerebro is pure storage and never calls an LLM. A hook or skill produces the
  summary and writes it back, e.g.:
    cerebro digest input <id> | claude -p "$(cerebro digest prompt)" | cerebro digest write <id>

Options:
  --db <path>     Database file (default: $CEREBRO_DB or ~/.claude/cerebro/archive.sqlite)
  --full          index: ignore cursors and re-read everything (dedup skips known
                  messages, so stored text is never touched); show: print full text
  --rebuild       index: like --full, but also re-flatten the stored text of every
                  message still on disk (needed after a flattening/parser change;
                  messages whose source file is deleted are kept untouched)
  --dry-run       index: report what would be indexed, write nothing
  --limit <n>     Max rows to return
  --project <p>   sessions/search: filter by project path substring
  --since <date>  search: only messages at or after this ISO date (e.g. 2026-01-31)
  --all           search: every matching message instead of the best hit per thread
  --range <a..b>  show: only messages a through b (the outline / search #N numbering)
  --to <path>     backup: explicit target file (default: timestamped in backups/)
  --keep <n>      backup: prune oldest default-named backups beyond n
  --cwd <path>    recent: directory to scope by (default: current dir)
  --days <n>      recent: only threads active within the last n days (default 14)
  --context       recent/relevant: emit an agent-facing context block (for a hook)
  --stdin         relevant: read the prompt from a hook's JSON payload on stdin
  --ids           digest stale: print one full session id per line (for scripts)
  --model <name>  digest write: record which model produced the summary
  --bytes <n>     digest model: tier by an already-measured transcript byte count
                  (skips re-rendering the transcript; used by the hooks)
  --json          search/sessions/recent/relevant/show/stats/digest stale|search|show:
                  emit the rows as JSON instead of the human listing
  -h, --help      Show this help

Env:
  CEREBRO_DB           Override the database path
  CEREBRO_CLAUDE_DIR   Override the ~/.claude directory`;
