// CLI options as data: what a flag parses to, how it is validated, and what a
// command receives when it is absent.
//
// A command declares the flags it accepts, and that declaration is the single
// source of two things: the dispatcher rejects any flag a command did not declare
// (a flag meant for another command used to be swallowed in silence), and it
// coerces and validates the ones it did, so a handler never repeats a
// parse-check-report block and receives typed arguments instead of raw strings.

// Thrown by a coercion (and by handlers) for anything the user can get wrong.
// runCli turns it into a clean message plus exit 1, never a stack trace.
export class CliError extends Error {}

export interface OptionSpec<T> {
  kind: "string" | "boolean";
  // Turn a supplied raw value into what the command receives. Throws CliError on
  // bad input. Never called for a boolean or for an absent option.
  coerce: (raw: string, name: string) => T;
  // What the command receives when the flag is absent.
  absent: T;
}

// A command's option table. Declare it with `satisfies OptionTable` so the literal
// keeps its precise per-flag types and OptionValues can infer them.
export type OptionTable = { readonly [name: string]: OptionSpec<unknown> };

// The arguments a command's run step receives, derived from its option table.
export type OptionValues<T extends OptionTable> = {
  [K in keyof T]: T[K] extends OptionSpec<infer V> ? V : never;
};

// A boolean flag. Absent means false, never undefined, so a handler can branch on
// it directly.
export const flag = (): OptionSpec<boolean> => ({
  kind: "boolean",
  coerce: () => true,
  absent: false,
});

// A plain string option with no validation beyond being present.
export const text = (): OptionSpec<string | undefined> => ({
  kind: "string",
  coerce: (raw) => raw,
  absent: undefined,
});

// A numeric option. Fractions are meaningful for some options (--days multiplies
// into a millisecond cutoff, so 1.5 is a day and a half), so integrality is opt-in
// rather than the rule. `label` is the noun phrase in the error, so each option
// keeps the exact wording its tests pin.
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

// A row-count option (--limit, --keep): a positive integer. One builder owns the
// rule and its error wording, so the seven commands that take one cannot drift on
// either.
export const positiveInt = (): OptionSpec<number | undefined> =>
  numeric({ integer: true, min: 1, label: "a positive integer" });

// An ISO date option (the `--since` shape). Anchored shape check plus a round-trip
// calendar check: an unanchored regex would let "2026-31-01" or trailing garbage
// through, and Date.parse alone is engine-dependent (JSC rolls "2026-02-30" over to
// March 2). A bad date would make the lexical ts comparison silently exclude
// everything instead of erroring.
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

// A closed set of allowed values, reported in the error so the user does not have
// to go looking in --help.
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

// `--range N` or `--range A..B`, resolved to a from/to pair. Only the shape is
// checked here; whether the range fits the thread is the command's business,
// because only it knows how long the thread is.
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

// Apply a command's option table to what the parser produced. Absent flags take
// their declared absent value; supplied ones are coerced (and so validated) here,
// once, instead of in every handler.
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
