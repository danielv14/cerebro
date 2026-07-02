import type { StaleThread, StoredSummary, SummaryHit } from "./digest.ts";
import type { DryRunResult, IndexResult } from "./indexer.ts";
import type { RelevantThread, SearchHit, Stats, ThreadRow } from "./query.ts";
import type { ThreadMessage } from "./thread.ts";

// The presentation module for the CLI. cli.ts hands it typed rows and gets back the
// exact lines to emit; the command layer never formats anything itself. Two surfaces
// live here:
//
//   1. The listing/report builders (searchListing, recentBlock, showOutline, ...) are
//      the interface cli.ts uses: one builder per command output, each returning the
//      finished lines (intro + rows + footer). They hide every column width, padding,
//      truncation length, and the context-vs-plain branching. cli.ts imports only
//      these; it owns no widths.
//   2. The low-level primitives (shortId, oneLine, ...) and the agent-facing context
//      blocks are exported for direct unit/contract tests, not for the command layer.
//      cli.ts must not import them.
//
// Everything here is dependency-free and side-effect-free (it returns strings, never
// prints, never touches the db): only type imports for the row shapes it renders. CLI
// output is consumed by hooks and agents, so the exact bytes are load-bearing: do not
// change spacing, widths, truncation lengths, or labels without updating the tests in
// lockstep.

export const shortId = (id: string): string => id.slice(0, 8);

// Stored timestamps are verbatim UTC (ISO-8601 with a trailing Z) from the JSONL.
// Display them in Swedish wall-clock time. sv-SE formats as "2026-06-18 22:12",
// matching the previous "YYYY-MM-DD HH:mm" shape with the offset applied, and
// handles DST (CET/CEST) per date.
const DISPLAY_TZ = "Europe/Stockholm";

export const shortTime = (ts: string | null | undefined): string => {
  if (!ts) return "????-??-?? ??:??";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "????-??-?? ??:??";
  return date.toLocaleString("sv-SE", {
    timeZone: DISPLAY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export const shortDate = (ts: string | null | undefined): string => {
  if (!ts) return "??????????";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "??????????";
  return date.toLocaleDateString("sv-SE", { timeZone: DISPLAY_TZ });
};

export const projectName = (path: string | null): string =>
  path ? (path.split("/").filter(Boolean).pop() ?? path) : "(unknown)";

export const oneLine = (text: string, max = 100): string => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
};

export const humanBytes = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const formatted = unit === 0 ? String(value) : value.toFixed(1);
  return `${formatted} ${units[unit]}`;
};

// ── Internal per-row builders ─────────────────────────────────────────────────
// The two-line thread row repeats across the `recent` command (plain and --context
// branches) and partly elsewhere. The shared shape is:
//   "  <id>  <date>  [<n> msgs  ]<title>"   (line 1, two-space indent)
//   "      opened: <opening>"               (line 2, six-space indent, optional)
// These compose the listing builders below and are not part of the cli-facing
// interface, so they stay un-exported; their output is pinned through the builders.

// Line 1 of a `recent` thread row. `showMsgs: false` (the --context branch) drops
// the "N msgs" column; otherwise the count is right-padded to width 4. The title is
// truncated at 90 columns in both branches.
const recentThreadLine = (
  thread: { id: string; last_ts: string | null; msgs: number; title: string | null },
  opts: { showMsgs: boolean },
): string => {
  const msgs = opts.showMsgs ? `${String(thread.msgs).padStart(4)} msgs  ` : "";
  return `  ${shortId(thread.id)}  ${shortDate(thread.last_ts)}  ${msgs}${oneLine(thread.title ?? "(untitled)", 90)}`;
};

// The "opened:" follow-up line shared by `recent` and `relevant`. Truncated at 120.
const openedLine = (opening: string): string => `      opened: ${oneLine(opening, 120)}`;

// Line 1 of a `sessions` thread row: no leading indent, wall-clock time, the message
// count, the project name, then resume and "[body deleted]" suffixes. Distinct from
// `recentThreadLine` (no indent, time vs date, project as the trailing field, the
// title on its own follow-up line). The "+N resume(s)" suffix appears only when the
// thread has resumes, and "[body deleted]" only when the underlying source is gone.
const sessionThreadLine = (thread: {
  id: string;
  last_ts: string | null;
  msgs: number;
  sessions_in_thread: number;
  project_path: string | null;
  body_available: number;
}): string => {
  const resumes =
    thread.sessions_in_thread > 1 ? ` +${thread.sessions_in_thread - 1} resume(s)` : "";
  const deleted = thread.body_available === 0 ? "  [body deleted]" : "";
  return `${shortId(thread.id)}  ${shortTime(thread.last_ts)}  ${String(thread.msgs).padStart(4)} msgs  ${projectName(thread.project_path)}${resumes}${deleted}`;
};

// Line 1 of a `relevant` thread row: id, date, project, title. Distinct from the
// `recent` / `sessions` rows.
const relevantThreadLine = (thread: {
  id: string;
  last_ts: string | null;
  project_path: string | null;
  title: string | null;
}): string =>
  `  ${shortId(thread.id)}  ${shortDate(thread.last_ts)}  ${projectName(thread.project_path)}  ${oneLine(thread.title ?? "(untitled)", 80)}`;

// The snippet follow-up line for a `relevant` row. The label flags which FTS tier the
// snippet came from: a curated summary outranks a raw-transcript match.
const relevantSnippetLine = (snippet: string, fromSummary: boolean): string =>
  `      ${fromSummary ? "summary: " : "match:  "}${oneLine(snippet, 120)}`;

// The shared header of `show` (outline and full): id + message count, with a blank
// line under it (the trailing "\n" plus io.log's own newline).
const threadHeader = (sessionId: string, count: number): string =>
  `Thread ${shortId(sessionId)}  ${count} message(s)\n`;

// ── Agent-facing context blocks ───────────────────────────────────────────────
// The blocks emitted under --context are cerebro's contract with the consuming
// hook/agent: these exact bytes are injected into the model on every prompt
// (relevant) and session start (recent). They are exported so the contract has its
// own pinned tests; cli.ts reaches them only through recentBlock / relevantBlock. The
// two commands' blocks deliberately differ (recent is repo-scoped and hides the msg
// count; relevant labels summary vs match snippets). The "Background only; ignore …"
// guardrail (which stops injected history derailing the task) and the recall
// instructions (cerebro show / search) are load-bearing; tests pin them.

export const recentContextIntro = (repoLabel: string): string =>
  `Recent Claude Code sessions in this repo (${repoLabel}), from the cerebro archive. ` +
  "Background only; ignore if unrelated to the current task.";

export const recentContextFooter = (): string =>
  "\nIf the request overlaps with any of these, recall that work instead of starting over:\n" +
  "  cerebro show <id>          thread outline (add --full for the transcript)\n" +
  '  cerebro search "<terms>"   full-text search across all past sessions';

export const relevantContextIntro = (): string =>
  "Possibly relevant past Claude Code sessions (from the cerebro archive, matched " +
  "against this prompt). Background only; ignore any that do not actually relate.";

// The recall footer shared by both `relevant` branches (context and plain).
export const relevantFooter = (): string =>
  "\nTo recall one: cerebro show <id> (add --full for the transcript), " +
  'or cerebro search "<terms>".';

// ── Listing / report builders (the cli-facing interface) ──────────────────────
// Each returns the finished lines for one command's output. cli.ts fetches the rows,
// calls one of these, and emits the result line by line. Empty-state and exit
// decisions stay in cli.ts; these assume there is something to render.

// `search`: one header + one snippet line per hit, then the count footer. The
// thread title (when there is one) trails the header line, truncated at 60, so a
// hit is recognizable without opening it. The default (deduplicated) mode says so
// in the footer and points at --all; `all` restores the plain per-message footer.
export const searchListing = (hits: SearchHit[], opts: { all?: boolean } = {}): string[] => {
  const lines: string[] = [];
  for (const hit of hits) {
    const title = hit.title ? `  ${oneLine(hit.title, 60)}` : "";
    lines.push(
      `${shortId(hit.session_id)}  ${shortTime(hit.ts)}  ${hit.role.padEnd(9)}  ${projectName(hit.project_path)}${title}`,
    );
    // The ordinal is the message's position in show's numbering, so the hit can be
    // opened in place with show <id> --range.
    lines.push(`    #${hit.ordinal}  ${oneLine(hit.snippet, 160)}`);
  }
  lines.push(
    opts.all
      ? `\n${hits.length} hit(s). Open one with: cerebro show <id> (jump to a hit: --range <n>)`
      : `\n${hits.length} hit(s), best per thread (--all for every message). ` +
          "Open one with: cerebro show <id> (jump to a hit: --range <n>)",
  );
  return lines;
};

// `sessions`: the thread row plus the title on its own follow-up line (truncated at
// 120). No intro, no footer.
export const sessionsListing = (threads: ThreadRow[]): string[] => {
  const lines: string[] = [];
  for (const thread of threads) {
    lines.push(sessionThreadLine(thread));
    lines.push(`    ${oneLine(thread.title ?? "(untitled)", 120)}`);
  }
  return lines;
};

// `recent`: repo-scoped recent threads. The context branch emits the agent-facing
// block (intro + rows without the msg count + recall footer); the plain branch shows
// the msg count and a human header/footer. `repoPath` is the matched git root or cwd;
// the label is derived here. Openings are passed in so this stays db-free.
export const recentBlock = (
  rows: { thread: ThreadRow; opening: string | null }[],
  opts: { repoPath: string; days: number; context: boolean },
): string[] => {
  const repoLabel = projectName(opts.repoPath);
  const lines: string[] = [];
  lines.push(
    opts.context
      ? recentContextIntro(repoLabel)
      : `Recent sessions in ${repoLabel} (last ${opts.days} days):`,
  );
  for (const { thread, opening } of rows) {
    lines.push(recentThreadLine(thread, { showMsgs: !opts.context }));
    if (opening) lines.push(openedLine(opening));
  }
  lines.push(
    opts.context
      ? recentContextFooter()
      : '\nPull prior context: cerebro show <id>  |  cerebro search "<terms>"',
  );
  return lines;
};

// `relevant`: threads relevant to a prompt, summary-first. Each row carries its own
// opening and snippet (and which FTS tier the snippet is from). The context branch
// swaps the intro for the agent-facing one; the recall footer is shared by both.
export const relevantBlock = (threads: RelevantThread[], opts: { context: boolean }): string[] => {
  const lines: string[] = [];
  lines.push(opts.context ? relevantContextIntro() : "Related past sessions:");
  for (const thread of threads) {
    lines.push(relevantThreadLine(thread));
    if (thread.opening) lines.push(openedLine(thread.opening));
    if (thread.snippet) lines.push(relevantSnippetLine(thread.snippet, thread.fromSummary));
  }
  lines.push(relevantFooter());
  return lines;
};

// `show` (outline): the header, then a numbered one-line-per-message digest, then the
// hint to open the full transcript.
export const showOutline = (sessionId: string, messages: ThreadMessage[]): string[] => {
  const lines: string[] = [threadHeader(sessionId, messages.length)];
  messages.forEach((message, i) => {
    const marker = message.is_sidechain ? "[subagent] " : "";
    lines.push(
      `${String(i + 1).padStart(3)}. ${message.role.padEnd(9)} ${shortTime(message.ts)}  ${marker}${oneLine(message.text, 110)}`,
    );
  });
  lines.push("\nFull transcript: cerebro show <id> --full");
  return lines;
};

// `show --full`: the header, then each message rendered verbatim under a separator
// header, with a blank line between messages.
export const showFull = (sessionId: string, messages: ThreadMessage[]): string[] => {
  const lines: string[] = [threadHeader(sessionId, messages.length)];
  for (const message of messages) {
    const tag = message.is_sidechain ? " · subagent" : "";
    lines.push(`──── ${message.role}${tag} · ${shortTime(message.ts)} ────`);
    lines.push(message.text);
    lines.push("");
  }
  return lines;
};

// `show --range A..B`: a verbatim slice of the thread, numbered with the same
// ordinals as the outline (and as search's #N markers), so a search hit can be
// opened in place without pulling the whole transcript.
export const showRange = (
  sessionId: string,
  slice: ThreadMessage[],
  opts: { from: number; total: number },
): string[] => {
  const to = opts.from + slice.length - 1;
  const lines: string[] = [
    `Thread ${shortId(sessionId)}  showing ${opts.from}..${to} of ${opts.total} message(s)\n`,
  ];
  slice.forEach((message, i) => {
    const tag = message.is_sidechain ? " · subagent" : "";
    lines.push(`──── #${opts.from + i} ${message.role}${tag} · ${shortTime(message.ts)} ────`);
    lines.push(message.text);
    lines.push("");
  });
  return lines;
};

// `digest stale` (human): one row per stale thread with the staleness reason, the
// title on its own line, then the how-to-summarize footer. `promptVersion` is passed
// in so this stays free of the digest module.
export const staleListing = (rows: StaleThread[], opts: { promptVersion: number }): string[] => {
  const lines: string[] = [];
  for (const row of rows) {
    const reason =
      row.summary_version == null
        ? "never summarized"
        : row.summary_version < opts.promptVersion
          ? `prompt v${row.summary_version} < v${opts.promptVersion}`
          : "new activity since summary";
    lines.push(
      `${shortId(row.id)}  ${shortTime(row.last_ts)}  ${String(row.msgs).padStart(4)} msgs  ${projectName(row.project_path)}  [${reason}]`,
    );
    lines.push(`    ${oneLine(row.title ?? "(untitled)", 100)}`);
  }
  lines.push(
    `\n${rows.length} thread(s) need a summary. Summarize one:\n` +
      `  cerebro digest input <id> | claude -p "$(cerebro digest prompt)" | cerebro digest write <id>`,
  );
  return lines;
};

// `digest stale --ids`: machine mode for the batch hook. One full session id per
// line, nothing else, so a caller never scrapes the human listing format.
export const staleIds = (rows: StaleThread[]): string[] => rows.map((row) => row.id);

// `digest search`: one header + one snippet line per summary hit, then the count
// footer pointing at both the thread and its stored summary.
export const summarySearchListing = (hits: SummaryHit[]): string[] => {
  const lines: string[] = [];
  for (const hit of hits) {
    lines.push(
      `${shortId(hit.id)}  ${shortTime(hit.last_ts)}  ${projectName(hit.project_path)}  ${oneLine(hit.title ?? "(untitled)", 70)}`,
    );
    lines.push(`    ${oneLine(hit.snippet, 160)}`);
  }
  lines.push(
    `\n${hits.length} summary hit(s). Open one: cerebro show <id>  |  full summary: cerebro digest show <id>`,
  );
  return lines;
};

// `digest show`: the summary header (root id, time, model, prompt version) then the
// stored summary body.
export const digestShow = (summary: StoredSummary): string[] => {
  const model = summary.model ? `, ${summary.model}` : "";
  return [
    `Summary for thread ${shortId(summary.root_session_id)}  ` +
      `(${shortTime(summary.summarized_at)}${model}, prompt v${summary.prompt_version})\n`,
    summary.summary,
  ];
};

// `digest show` empty state: no summary stored yet for this thread.
export const noSummaryHint = (sessionId: string): string =>
  `No summary yet for ${shortId(sessionId)}. Generate the backlog with: cerebro digest stale`;

// `digest write` confirmation: which thread the summary was saved to and its size.
export const summarySaved = (root: string, chars: number): string =>
  `Saved summary for thread ${shortId(root)} (${chars} chars).`;

// `backup`: where the snapshot landed, its size, and anything pruned.
export const backupReport = (result: {
  path: string;
  bytes: number;
  pruned: string[];
}): string[] => {
  const lines = [`Backup written: ${result.path} (${humanBytes(result.bytes)})`];
  for (const pruned of result.pruned) lines.push(`Pruned old backup: ${pruned}`);
  return lines;
};

// `index`: the one-line result of a real run.
export const indexResult = (result: IndexResult): string[] => [
  `Indexed ${result.newMessages} new message(s) ` +
    `(${result.filesIndexed}/${result.filesScanned} files touched).`,
];

// `index --rebuild`: like indexResult but states what a rebuild actually did:
// texts of on-disk messages were re-flattened in place, deleted sources kept.
export const rebuildResult = (result: IndexResult): string[] => [
  `Rebuilt from disk: ${result.newMessages} net-new message(s), stored texts re-flattened ` +
    `(${result.filesIndexed}/${result.filesScanned} files read; messages from deleted sources kept).`,
];

// `stats`: the archive counts, labels left-aligned to a shared column. `extras`
// carries what the query layer cannot know: the database file size (measured on
// the path by cli.ts; null for :memory: or a missing file) and the stale-thread
// count (owned by the digest layer, since it depends on the prompt version).
export const statsReport = (
  s: Stats,
  extras: { dbBytes: number | null; staleThreads: number } = { dbBytes: null, staleThreads: 0 },
): string[] => {
  const lines = [
    `Threads:          ${s.threads} (${s.summarizedThreads} summarized, ${extras.staleThreads} stale)`,
    `Sessions:         ${s.sessions}`,
    `Messages:         ${s.messages}`,
    `Deleted sources:  ${s.deletedSources}`,
    `Span:             ${shortDate(s.firstTs)} .. ${shortDate(s.lastTs)}`,
  ];
  if (extras.dbBytes !== null) lines.push(`Database size:    ${humanBytes(extras.dbBytes)}`);
  if (s.topProjects.length > 0) {
    lines.push(
      `Top projects:     ${s.topProjects
        .map((p) => `${projectName(p.project_path)} (${p.threads})`)
        .join(", ")}`,
    );
  }
  return lines;
};

// `index --dry-run`: what a real run would do, writing nothing. Three shapes: a
// --full re-read, an up-to-date archive with nothing to do, or a normal incremental
// plan. All end with the same "nothing written" line.
export const dryRunReport = (plan: DryRunResult): string[] => {
  const lines: string[] = [];
  if (plan.full) {
    lines.push(`Dry run (--full): would re-read all ${plan.filesToRead} file(s).`);
    lines.push(`  Candidate messages: ${plan.candidateMessages} (before UUID dedup)`);
    lines.push(`  Bytes to read:      ${humanBytes(plan.newBytes)}`);
    lines.push("  On an up-to-date archive dedup collapses this to ~0 net-new messages.");
  } else if (plan.filesToRead === 0) {
    lines.push(
      `Dry run: nothing to index. ${plan.unchangedFiles}/${plan.filesScanned} files unchanged.`,
    );
  } else {
    lines.push("Dry run. Would index:");
    lines.push(`  New messages:  ${plan.candidateMessages}`);
    lines.push(`  New bytes:     ${humanBytes(plan.newBytes)}`);
    lines.push(
      `  Files:         ${plan.newFiles} new, ${plan.grownFiles} grown, ` +
        `${plan.truncatedFiles} truncated, ${plan.unchangedFiles} unchanged (skipped)`,
    );
  }
  lines.push("\nNothing written. Run `cerebro index` to apply.");
  return lines;
};
