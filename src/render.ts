// Shared formatting primitives for the CLI. The per-command listing/report
// builders live with their commands in src/commands/ (each command module owns
// its output format end to end); what remains here is the vocabulary they share:
// id/time/path/size shorthands and the row fragments used by more than one
// command. Everything is dependency-free and side-effect-free (returns strings,
// never prints, never touches the db). CLI output is consumed by hooks and
// agents, so the exact bytes are load-bearing: do not change spacing, widths,
// truncation lengths, or labels without updating the tests in lockstep.

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

// The "opened:" follow-up line shared by the `recent` and `relevant` rows (its two
// consumers are why it lives here and not in either command). Truncated at 120.
export const openedLine = (opening: string): string => `      opened: ${oneLine(opening, 120)}`;
