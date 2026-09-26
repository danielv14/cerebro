// The one display zone: the renderer shows times in it and `--since` dates are
// midnights in it, so a date typed from a listing means what the listing shows.

const DEFAULT_DISPLAY_TZ = "Europe/Stockholm";

// An unknown zone makes Intl throw a RangeError, so each requested zone is
// validated once and an invalid one falls back rather than taking a listing down.
const validZones = new Map<string, boolean>();
const isValidZone = (zone: string): boolean => {
  let valid = validZones.get(zone);
  if (valid === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      valid = true;
    } catch {
      valid = false;
    }
    validZones.set(zone, valid);
  }
  return valid;
};

// Read on every call, not cached: tests move CEREBRO_TZ between cases.
export const displayTz = (): string => {
  const requested = process.env.CEREBRO_TZ;
  return requested && isValidZone(requested) ? requested : DEFAULT_DISPLAY_TZ;
};

// Building an Intl.DateTimeFormat is the expensive part of formatting a date.
export const perZone = <T>(build: (zone: string) => T): ((zone: string) => T) => {
  const cache = new Map<string, T>();
  return (zone) => {
    let value = cache.get(zone);
    if (value === undefined) {
      value = build(zone);
      cache.set(zone, value);
    }
    return value;
  };
};

// h23, not hour12: false, which some engines render as "24" at midnight.
const wallClock = perZone(
  (zone) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }),
);

const zoneOffsetMs = (zone: string, instant: number): number => {
  const parts: Record<string, number> = {};
  for (const part of wallClock(zone).formatToParts(instant)) parts[part.type] = Number(part.value);
  const asUtc = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
};

// The second pass corrects for a DST change between the guess and the answer.
export const zonedMidnightIso = (isoDate: string, zone: string): string => {
  const [year, month, day] = isoDate.split("-").map(Number);
  const utcMidnight = Date.UTC(year!, month! - 1, day!);
  const first = utcMidnight - zoneOffsetMs(zone, utcMidnight);
  return new Date(utcMidnight - zoneOffsetMs(zone, first)).toISOString();
};
