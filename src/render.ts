// Pure formatting helpers for the CLI. Kept dependency-free and side-effect-free
// (they return strings, never print) so the command layer in cli.ts stays thin and
// these stay unit-testable. CLI output is consumed by hooks and agents, so the exact
// bytes these produce are load-bearing: do not change spacing, widths, truncation
// lengths, or labels without updating the callers and tests in lockstep.

export const shortId = (id: string): string => id.slice(0, 8);

// Stored timestamps are verbatim UTC (ISO-8601 with a trailing Z) from the JSONL.
// Display them in Swedish wall-clock time. sv-SE formats as "2026-06-18 22:12",
// matching the previous "YYYY-MM-DD HH:mm" shape with the offset applied, and
// handles DST (CET/CEST) per date.
export const DISPLAY_TZ = "Europe/Stockholm";

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
  return collapsed.length > max ? collapsed.slice(0, max - 1) + "…" : collapsed;
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

// The two-line thread row repeats across the `recent` command (plain and --context
// branches) and partly elsewhere. The shared shape is:
//   "  <id>  <date>  [<n> msgs  ]<title>"   (line 1, two-space indent)
//   "      opened: <opening>"               (line 2, six-space indent, optional)
// The only deliberate difference between the two `recent` branches is whether the
// message count is shown, so it is a single explicit option.

// Line 1 of a `recent` thread row. `showMsgs: false` (the --context branch) drops
// the "N msgs" column; otherwise the count is right-padded to width 4. The title is
// truncated at 90 columns in both branches.
export const recentThreadLine = (
  thread: { id: string; last_ts: string | null; msgs: number; title: string | null },
  opts: { showMsgs: boolean },
): string => {
  const msgs = opts.showMsgs ? `${String(thread.msgs).padStart(4)} msgs  ` : "";
  return `  ${shortId(thread.id)}  ${shortDate(thread.last_ts)}  ${msgs}${oneLine(thread.title ?? "(untitled)", 90)}`;
};

// The "opened:" follow-up line shared by `recent` and `relevant`. Truncated at 120.
export const openedLine = (opening: string): string => `      opened: ${oneLine(opening, 120)}`;

// Line 1 of a `sessions` thread row: no leading indent, wall-clock time, the message
// count, the project name, then resume and "[body deleted]" suffixes. Distinct from
// `recentThreadLine` (no indent, time vs date, project as the trailing field, the
// title on its own follow-up line), so it is its own renderer rather than a flag on
// a shared one. The "+N resume(s)" suffix appears only when the thread has resumes,
// and "[body deleted]" only when the underlying source is gone.
export const sessionThreadLine = (thread: {
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
