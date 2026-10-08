export const HELP = `cerebro - permanent verbatim archive + search over Claude Code sessions

Usage:
  cerebro index [--full] [--rebuild] [--dry-run]   Index all sessions incrementally
  cerebro search <query> [--limit N] [--project P] [--branch B] [--since D] [--role R]
                         [--prose] [--all] [--json]
                                         Full-text search (ranked, best hit per thread;
                                         --all for every matching message)
  cerebro sessions [--project P] [--branch B] [--since D] [--limit N] [--json]
                                         List threads, newest first
  cerebro recent [--cwd P] [--days D] [--limit N] [--json]
                                         Recent threads for one repo
  cerebro relevant <prompt> [--limit N] [--cwd P] [--json]
                                         Past threads relevant to a prompt (threads in
                                         --cwd's repo rank higher)
  cerebro show <session-id> [--full] [--range A..B] [--grep T] [--json]
                                         Show a thread (outline, full transcript, a
                                         verbatim slice in outline numbering, or the
                                         turns containing T)
  cerebro stats [--json]                 Archive counts
  cerebro skills [--since D] [--limit N] [--json]
                                         How often each skill was invoked (both the
                                         typed /name and the model's Skill calls)
  cerebro doctor [--full] [--json]       Read-only health report (integrity, schema,
                                         digest backlog, deployed-binary drift, hooks);
                                         exit 1 only on a hard failure
  cerebro version [--json]               Build identity of this binary
  cerebro backup [--to <path>] [--keep N]
                                         Snapshot the database (VACUUM INTO); default
                                         target <db-dir>/backups/archive-<ts>.sqlite
  cerebro maintain                       Optimize the FTS indexes, refresh planner
                                         stats, and truncate the WAL
  cerebro digest <action>                Curated session summaries (see below)

Digest actions:
  cerebro digest stale [--limit N] [--ids] [--json]
                                              List threads needing a (re)summary
  cerebro digest run <id> | --stdin           Summarize one thread end to end
  cerebro digest drain [--limit N]            Summarize the stalest N threads (default 8)
  cerebro digest search <query> [--limit N] [--json]
                                              Full-text search the summaries
  cerebro digest show <id> [--json]           Print a thread's stored summary

  run/drain spawn \`claude -p\` with the model the tiering picked and store the
  result only if it succeeded and is not an error string. cerebro owns the prompt,
  the tiering and the storage guard; it never summarizes on its own initiative.

Options:
  --db <path>     Database file (default: $CEREBRO_DB or ~/.claude/cerebro/archive.sqlite)
  --full          index: ignore cursors and re-read everything (dedup skips known
                  messages, so stored text is never touched); show: print full text;
                  doctor: the complete integrity_check instead of quick_check,
                  plus the line kinds the indexer skips
  --rebuild       index: like --full, but also re-flatten the stored text of every
                  message still on disk (needed after a flattening/parser change;
                  messages whose source file is deleted are kept untouched)
  --dry-run       index: report what would be indexed, write nothing
  --limit <n>     Max rows to return (skills: no limit by default, so a rarely used
                  skill is never trimmed into looking unused)
  --project <p>   sessions/search: filter by project path substring (the thread's,
                  so a resume is never dropped for lacking its own cwd)
  --branch <b>    sessions/search: filter by git branch substring. A thread matches
                  when any of its sessions was recorded on the branch. A session
                  stores one branch (whichever its most recent indexing run saw
                  first), so a mid-session branch switch can move the session to
                  the new branch rather than matching both
  --since <when>  search: only messages at or after this point; sessions: only
                  threads last active at or after it; skills: only calls at or after
                  it. An ISO date (2026-01-31, midnight in the display zone) or an
                  age (7d, 2w)
  --role <r>      search: only user or assistant turns. A tool_result is recorded as
                  a user turn, so --role user --prose is the "only my own prompts" query
  --prose         search: drop messages that are nothing but flattened tool plumbing
                  (a message that opens with prose and then calls a tool is kept)
  --all           search: every matching message instead of the best hit per thread
  --range <a..b>  show: only messages a through b (the outline / search #N numbering)
  --grep <text>   show: only the turns containing text (case-insensitive substring),
                  with their outline numbers
  --to <path>     backup: explicit target file (default: timestamped in backups/)
  --keep <n>      backup: prune oldest default-named backups beyond n
  --cwd <path>    recent: directory to scope by (default: current dir); relevant:
                  repo whose threads get a ranking boost (default: no boost)
  --days <n>      recent: only threads active within the last n days (default 14)
  --stdin         digest run: read the session id from a SessionEnd payload
  --ids           digest stale: print one full session id per line (for scripts)
  --json          search/sessions/recent/relevant/show/stats/skills/doctor/version/
                  digest stale|search|show: emit the rows as JSON instead of the
                  human listing. A command that does not list it here rejects it,
                  as it does any other flag that is not its own.
  -h, --help      Show this help

Env:
  CEREBRO_DB           Override the database path
  CEREBRO_CLAUDE_DIR   Override the directory session transcripts are read from
  CLAUDE_CONFIG_DIR    Claude Code's own config dir; where deploy installs the
                       binary and where doctor looks for it and settings.json
  CEREBRO_TZ           IANA zone for displayed timestamps and --since dates (default
                       Europe/Stockholm; stored timestamps are always verbatim UTC)
  CEREBRO_CLAUDE_BIN   The binary digest run/drain spawn (default: claude on PATH)`;
