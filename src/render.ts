import { displayTz, perZone } from "./tz.ts";

export const shortId = (id: string): string => id.slice(0, 8);

// The sv-SE locale is NOT a preference: it produces the "YYYY-MM-DD HH:mm" shape
// the tests pin, so it stays fixed while the zone moves (CEREBRO_TZ).
const timeFormat = perZone(
  (zone) =>
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }),
);
const dateFormat = perZone(
  (zone) =>
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: zone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }),
);

const parseTs = (ts: string | null | undefined): Date | null => {
  if (!ts) return null;
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const shortTime = (ts: string | null | undefined): string => {
  const date = parseTs(ts);
  if (!date) return "????-??-?? ??:??";
  return timeFormat(displayTz()).format(date);
};

export const shortDate = (ts: string | null | undefined): string => {
  const date = parseTs(ts);
  if (!date) return "??????????";
  return dateFormat(displayTz()).format(date);
};

export const projectName = (path: string | null): string =>
  path ? (path.split("/").filter(Boolean).pop() ?? path) : "(unknown)";

// Counted in code points, so a cut never leaves half a surrogate pair behind. The
// first 2*max code units hold at least max code points, so only that head is split.
export const oneLine = (text: string, max = 100): string => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  const head = Array.from(collapsed.slice(0, 2 * max));
  if (head.length <= max && collapsed.length <= 2 * max) return collapsed;
  return `${head.slice(0, max - 1).join("")}…`;
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
