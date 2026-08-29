// CLI options as data: what a flag parses to, how it is validated, and what a
// command receives when it is absent. See CLAUDE.md ("How a command is shaped").

// Thrown for anything the user can get wrong. runCli turns it into a clean message
// plus exit 1, never a stack trace.
export class CliError extends Error {}

export interface OptionSpec<T> {
  kind: "string" | "boolean";
  // Throws CliError on bad input. Never called for a boolean or an absent option.
  coerce: (raw: string, name: string) => T;
  // What the command receives when the flag is absent.
  absent: T;
}

// Declare with `satisfies OptionTable` so the literal keeps its precise per-flag
// types and OptionValues can infer them.
export type OptionTable = { readonly [name: string]: OptionSpec<unknown> };

export type OptionValues<T extends OptionTable> = {
  [K in keyof T]: T[K] extends OptionSpec<infer V> ? V : never;
};

// Absent means false, never undefined, so a handler can branch on it directly.
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

// Fractions are meaningful for some options (--days multiplies into a millisecond
// cutoff), so integrality is opt-in. `label` is the noun phrase in the error, so
// each option keeps the exact wording its tests pin.
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

// One builder owns the row-count rule and its error wording, so the commands that
// take one cannot drift on either.
export const positiveInt = (): OptionSpec<number | undefined> =>
  numeric({ integer: true, min: 1, label: "a positive integer" });

// Anchored shape check plus a round-trip calendar check: an unanchored regex would
// let "2026-31-01" or trailing garbage through, and Date.parse alone is
// engine-dependent (JSC rolls "2026-02-30" over to March 2). A bad date would make
// the lexical ts comparison silently exclude everything instead of erroring.
export const isoDate = (): OptionSpec<string | undefined> => ({
  kind: "string",
  coerce: (raw, name) => {
    const parsed = Date.parse(`${raw}T00:00:00Z`);
    const roundTrips =
      /^\d{4}-\d{2}-\d{2}$/.test(raw) &&
      !Number.isNaN(parsed) &&
      new Date(parsed).toISOString().slice(0, 10) === raw;
    if (!roundTrips) {
      throw new CliError(`--${name} must be a valid ISO date like 2026-01-31 (got "${raw}")`);
    }
    return raw;
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

// `--range N` or `--range A..B`. Only the shape is checked here; whether the range
// fits the thread is the command's business, because only it knows the length.
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

// Absent flags take their declared absent value; supplied ones are coerced (and so
// validated) here, once, instead of in every handler.
export const readOptions = <T extends OptionTable>(
  table: T,
  parsed: Record<string, string | boolean | undefined>,
): OptionValues<T> => {
  const values: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(table)) {
    const raw = parsed[name];
    if (raw === undefined) values[name] = spec.absent;
    else if (spec.kind === "boolean") values[name] = raw === true;
    else values[name] = spec.coerce(String(raw), name);
  }
  return values as OptionValues<T>;
};
