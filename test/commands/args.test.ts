import { describe, expect, test } from "bun:test";
import {
  CliError,
  choice,
  flag,
  isoDate,
  messageRange,
  numeric,
  type OptionTable,
  readOptions,
  text,
} from "../../src/commands/args.ts";

// The coercions throw CliError with the exact wording the CLI prints, so each case
// asserts the message and not just the failure.
const coerce = (
  spec: { coerce: (raw: string, name: string) => unknown },
  raw: string,
  name: string,
) => spec.coerce(raw, name);

const message = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a CliError");
};

describe("numeric", () => {
  const positiveInteger = numeric({ integer: true, min: 1, label: "a positive integer" });
  const nonNegativeInteger = numeric({ integer: true, min: 0, label: "a non-negative integer" });
  const positiveNumber = numeric({ min: 0, minExclusive: true, label: "a positive number" });

  test("an absent option takes its declared absent value", () => {
    expect(positiveInteger.absent).toBeUndefined();
  });

  test("a valid value is parsed to a number", () => {
    expect(coerce(positiveInteger, "25", "limit")).toBe(25);
  });

  test("a non-numeric value fails with the label and the raw input", () => {
    expect(message(() => coerce(nonNegativeInteger, "lots", "bytes"))).toBe(
      '--bytes must be a non-negative integer (got "lots")',
    );
  });

  test("a value below an inclusive min fails", () => {
    expect(message(() => coerce(positiveInteger, "0", "limit"))).toBe(
      '--limit must be a positive integer (got "0")',
    );
  });

  test("an inclusive min accepts its boundary", () => {
    expect(coerce(nonNegativeInteger, "0", "bytes")).toBe(0);
  });

  test("an exclusive min rejects its boundary", () => {
    expect(message(() => coerce(positiveNumber, "0", "days"))).toBe(
      '--days must be a positive number (got "0")',
    );
  });

  test("a fraction fails where integers are required", () => {
    expect(message(() => coerce(positiveInteger, "1.5", "keep"))).toBe(
      '--keep must be a positive integer (got "1.5")',
    );
  });

  test("a fraction is accepted where integrality is not required", () => {
    expect(coerce(positiveNumber, "1.5", "days")).toBe(1.5);
  });

  test("Infinity and NaN are rejected even without the integer rule", () => {
    expect(message(() => coerce(positiveNumber, "Infinity", "days"))).toBe(
      '--days must be a positive number (got "Infinity")',
    );
    expect(message(() => coerce(positiveNumber, "nope", "days"))).toBe(
      '--days must be a positive number (got "nope")',
    );
  });
});

describe("isoDate", () => {
  test("accepts a real calendar date", () => {
    expect(coerce(isoDate(), "2026-01-31", "since")).toBe("2026-01-31");
  });

  test("rejects a transposed month, trailing garbage, and a date that does not exist", () => {
    for (const raw of ["2026-31-01", "2026-01-31foo", "2026-02-30"]) {
      expect(message(() => coerce(isoDate(), raw, "since"))).toBe(
        `--since must be a valid ISO date like 2026-01-31 (got "${raw}")`,
      );
    }
  });
});

describe("choice", () => {
  test("accepts an allowed value and reports the whole set on anything else", () => {
    const role = choice(["user", "assistant"] as const);
    expect(coerce(role, "user", "role")).toBe("user");
    expect(message(() => coerce(role, "system", "role"))).toBe(
      '--role must be one of user | assistant (got "system")',
    );
  });
});

describe("messageRange", () => {
  test("a single N is the one-message range N..N", () => {
    expect(coerce(messageRange(), "7", "range")).toEqual({ from: 7, to: 7 });
  });

  test("A..B is parsed to its endpoints", () => {
    expect(coerce(messageRange(), "2..5", "range")).toEqual({ from: 2, to: 5 });
  });

  test("rejects a malformed range, a zero start, and a reversed range", () => {
    for (const raw of ["abc", "0", "3..2", "1..", "1..2..3"]) {
      expect(message(() => coerce(messageRange(), raw, "range"))).toBe(
        `--range must be N or A..B with 1 <= A <= B (got "${raw}")`,
      );
    }
  });
});

describe("readOptions", () => {
  const table = {
    limit: numeric({ integer: true, min: 1, label: "a positive integer" }),
    project: text(),
    json: flag(),
  } satisfies OptionTable;

  test("absent options take their declared absent values, so a flag is false not undefined", () => {
    expect(readOptions(table, {})).toEqual({ limit: undefined, project: undefined, json: false });
  });

  test("supplied options are coerced to their declared types", () => {
    expect(readOptions(table, { limit: "5", project: "cerebro", json: true })).toEqual({
      limit: 5,
      project: "cerebro",
      json: true,
    });
  });

  test("a bad value throws CliError from the option that owns the rule", () => {
    expect(() => readOptions(table, { limit: "0" })).toThrow(CliError);
  });

  test("a value for an option the table does not declare is ignored", () => {
    // The dispatcher rejects those before this point; readOptions only ever reads
    // the names its own table declares.
    expect(readOptions(table, { keep: "3" })).toEqual({
      limit: undefined,
      project: undefined,
      json: false,
    });
  });
});
