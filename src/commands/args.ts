import { displayTz, zonedMidnightIso } from "../tz.ts";

export class CliError extends Error {}

export interface OptionSpec<T> {
  kind: "string" | "boolean";
  // Never called for a boolean or an absent option.
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

// Integrality is opt-in: fractions are meaningful for --days.
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

// Years from 1000 only: Date.UTC reads 0-99 as 19xx, and no archive predates 1000.
const isCalendarDate = (raw: string): boolean => {
  const parsed = Date.parse(`${raw}T00:00:00Z`);
  return (
    /^[1-9]\d{3}-\d{2}-\d{2}$/.test(raw) &&
    !Number.isNaN(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === raw
  );
};

// Resolves to an ISO instant, compared as a string against the stored UTC ts. The
// date is checked by shape and by a calendar round-trip: an unanchored regex lets
// "2026-31-01" through, and Date.parse alone rolls "2026-02-30" over to March 2.
export const sinceBound = (): OptionSpec<string | undefined> => ({
  kind: "string",
  coerce: (raw, name, now) => {
    if (isCalendarDate(raw)) return zonedMidnightIso(raw, displayTz());
    // Five digits keeps the bound inside Date's range, so toISOString cannot throw.
    const age = /^([1-9]\d{0,4})([dw])$/.exec(raw);
    if (age) {
      const days = Number(age[1]) * (age[2] === "w" ? 7 : 1);
      return new Date(now - days * 86_400_000).toISOString();
    }
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
