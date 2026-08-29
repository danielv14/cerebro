// CLI output is consumed by hooks and agents, so the exact bytes are load-bearing:
// do not change spacing, widths, truncation lengths, or labels without updating
// the tests in lockstep.

export const shortId = (id: string): string => id.slice(0, 8);

// The sv-SE locale is NOT a preference: it produces the "YYYY-MM-DD HH:mm" shape
// the tests pin, so it stays fixed while the zone moves (CEREBRO_TZ).
const DEFAULT_DISPLAY_TZ = "Europe/Stockholm";

// An unknown zone makes toLocaleString throw a RangeError, so it is validated
// once here and falls back rather than taking the listing down.
const displayTz = (): string => {
  const requested = process.env.CEREBRO_TZ;
  if (!requested) return DEFAULT_DISPLAY_TZ;
  try {
    new Intl.DateTimeFormat("sv-SE", { timeZone: requested });
    return requested;
  } catch {
    return DEFAULT_DISPLAY_TZ;
  }
};

const parseTs = (ts: string | null | undefined): Date | null => {
  if (!ts) return null;
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const shortTime = (ts: string | null | undefined): string => {
  const date = parseTs(ts);
  if (!date) return "????-??-?? ??:??";
  return date.toLocaleString("sv-SE", {
    timeZone: displayTz(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export const shortDate = (ts: string | null | undefined): string => {
  const date = parseTs(ts);
  if (!date) return "??????????";
  return date.toLocaleDateString("sv-SE", { timeZone: displayTz() });
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

export const openedLine = (opening: string): string => `      opened: ${oneLine(opening, 120)}`;
