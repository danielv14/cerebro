import { displayTz, zonedMidnightIso } from "../tz.ts";

// CLI options as data. See CLAUDE.md ("How a command is shaped").

// runCli turns this into a clean message plus exit 1, never a stack trace.
export class CliError extends Error {}

export interface OptionSpec<T> {
  kind: "string" | "boolean";
  // Throws CliError on bad input. Never called for a boolean or an absent option.
  // `now` is the dispatch's instant, for values relative to it.
  coerce: (raw: string, name: string, now: number) => T;
  absent: T;
}

// Declare with `satisfies OptionTable` so the literal keeps its per-flag types.
export type OptionTable = { readonly [name: string]: OptionSpec<unknown> };

export type OptionValues<T extends OptionTable> = {
  [K in keyof T]: T[K] extends OptionSpec<infer V> ? V : never;
};

export const flag = (): OptionSpec<boolean> => ({
  kind: "boolean",
  coerce: () => true,
  absent: false,
});

export const text = (): OptionSpec<string | undefined> => ({
  kind: "string",
  coerce: (raw) => raw,
  absent: undefined,
});

// Integrality is opt-in: fractions are meaningful for --days. `label` is the
// exact noun phrase in the error, pinned by tests.
export const numeric = (opts: {
  integer?: boolean;
  min: number;
  minExclusive?: boolean;
  label: string;
}): OptionSpec<number | undefined> => ({
  kind: "string",
  coerce: (raw, name) => {
    const value = Number(raw);
    const wellFormed = opts.integer ? Number.isInteger(value) : Number.isFinite(value);
    const aboveMin = opts.minExclusive ? value > opts.min : value >= opts.min;
    if (!wellFormed || !aboveMin) {
      throw new CliError(`--${name} must be ${opts.label} (got "${raw}")`);
    }
    return value;
  },
  absent: undefined,
});

export const positiveInt = (): OptionSpec<number | undefined> =>
  numeric({ integer: true, min: 1, label: "a positive integer" });

const isCalendarDate = (raw: string): boolean => {
  const parsed = Date.parse(`${raw}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(raw) &&
    !Number.isNaN(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === raw
  );
};

const DAY_MS = 86_400_000;
const RELATIVE_UNITS: Record<string, number> = { d: DAY_MS, w: 7 * DAY_MS };

// Resolves to an ISO instant, compared as a string against the stored UTC ts. A
// date is midnight in the display zone, so it means the day a listing shows; an
// age (7d, 2w) counts back from the dispatch's instant. The date is checked by
// shape and by a calendar round-trip: an unanchored regex lets "2026-31-01"
// through, and Date.parse alone rolls "2026-02-30" over to March 2. A bad date
// would silently exclude everything.
export const sinceBound = (): OptionSpec<string | undefined> => ({
  kind: "string",
  coerce: (raw, name, now) => {
    if (isCalendarDate(raw)) return zonedMidnightIso(raw, displayTz());
    // Five digits keeps the bound inside Date's range, so toISOString cannot throw.
    const age = /^([1-9]\d{0,4})([dw])$/.exec(raw);
    if (age) return new Date(now - Number(age[1]) * RELATIVE_UNITS[age[2]!]!).toISOString();
    throw new CliError(
      `--${name} must be an ISO date like 2026-01-31 or an age like 7d or 2w (got "${raw}")`,
    );
  },
  absent: undefined,
});

export const choice = <T extends string>(allowed: readonly T[]): OptionSpec<T | undefined> => ({
  kind: "string",
  coerce: (raw, name) => {
    if (!allowed.includes(raw as T)) {
      throw new CliError(`--${name} must be one of ${allowed.join(" | ")} (got "${raw}")`);
    }
    return raw as T;
  },
  absent: undefined,
});

export interface MessageRange {
  from: number;
  to: number;
}

// Shape only; whether the range fits the thread is the command's business.
export const messageRange = (): OptionSpec<MessageRange | undefined> => ({
  kind: "string",
  coerce: (raw, name) => {
    const match = raw.match(/^(\d+)(?:\.\.(\d+))?$/);
    const from = match ? Number(match[1]) : 0;
    const to = match?.[2] ? Number(match[2]) : from;
    if (!match || from < 1 || to < from) {
      throw new CliError(`--${name} must be N or A..B with 1 <= A <= B (got "${raw}")`);
    }
    return { from, to };
  },
  absent: undefined,
});

export const readOptions = <T extends OptionTable>(
  table: T,
  parsed: Record<string, string | boolean | undefined>,
  now: number,
): OptionValues<T> => {
  const values: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(table)) {
    const raw = parsed[name];
    if (raw === undefined) values[name] = spec.absent;
    else if (spec.kind === "boolean") values[name] = raw === true;
    else values[name] = spec.coerce(String(raw), name, now);
  }
  return values as OptionValues<T>;
};
