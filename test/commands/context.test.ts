import { describe, expect, test } from "bun:test";
import { numberOption, present } from "../../src/commands/context.ts";

// Collect the reported messages so each case can assert both the outcome and the
// exact wording (the four call sites pin their own labels in test/cli.test.ts).
const capture = () => {
  const messages: string[] = [];
  return { messages, fail: (message: string) => messages.push(message) };
};

const positiveInteger = { integer: true, min: 1, label: "a positive integer" } as const;
const nonNegativeInteger = { integer: true, min: 0, label: "a non-negative integer" } as const;
const positiveNumber = { min: 0, minExclusive: true, label: "a positive number" } as const;

describe("numberOption", () => {
  test("an absent option is ok with no value and no message", () => {
    const cap = capture();
    expect(numberOption(undefined, "limit", positiveInteger, cap.fail)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(cap.messages).toEqual([]);
  });

  test("a valid value is parsed to a number", () => {
    const cap = capture();
    expect(numberOption("25", "limit", positiveInteger, cap.fail)).toEqual({ ok: true, value: 25 });
    expect(cap.messages).toEqual([]);
  });

  test("a non-numeric value fails with the label and the raw input", () => {
    const cap = capture();
    expect(numberOption("lots", "bytes", nonNegativeInteger, cap.fail)).toEqual({ ok: false });
    expect(cap.messages).toEqual(['--bytes must be a non-negative integer (got "lots")']);
  });

  test("a value below an inclusive min fails", () => {
    const cap = capture();
    expect(numberOption("0", "limit", positiveInteger, cap.fail)).toEqual({ ok: false });
    expect(cap.messages).toEqual(['--limit must be a positive integer (got "0")']);
  });

  test("an inclusive min accepts its boundary", () => {
    const cap = capture();
    expect(numberOption("0", "bytes", nonNegativeInteger, cap.fail)).toEqual({
      ok: true,
      value: 0,
    });
    expect(cap.messages).toEqual([]);
  });

  test("an exclusive min rejects its boundary", () => {
    const cap = capture();
    expect(numberOption("0", "days", positiveNumber, cap.fail)).toEqual({ ok: false });
    expect(cap.messages).toEqual(['--days must be a positive number (got "0")']);
  });

  test("a fraction fails where integers are required", () => {
    const cap = capture();
    expect(numberOption("1.5", "keep", positiveInteger, cap.fail)).toEqual({ ok: false });
    expect(cap.messages).toEqual(['--keep must be a positive integer (got "1.5")']);
  });

  test("a fraction is accepted where integrality is not required", () => {
    const cap = capture();
    expect(numberOption("1.5", "days", positiveNumber, cap.fail)).toEqual({
      ok: true,
      value: 1.5,
    });
    expect(cap.messages).toEqual([]);
  });

  test("Infinity and NaN are rejected even without the integer rule", () => {
    const cap = capture();
    expect(numberOption("Infinity", "days", positiveNumber, cap.fail)).toEqual({ ok: false });
    expect(numberOption("nope", "days", positiveNumber, cap.fail)).toEqual({ ok: false });
    expect(cap.messages).toEqual([
      '--days must be a positive number (got "Infinity")',
      '--days must be a positive number (got "nope")',
    ]);
  });
});

// A CommandContext stub with just the three fields `present` reads, plus captured
// output so each mode can be asserted on the exact lines.
const presentCtx = (json: boolean) => {
  const logs: string[] = [];
  const jsonPayloads: unknown[] = [];
  return {
    logs,
    jsonPayloads,
    ctx: {
      io: {
        log: (line: string) => logs.push(line),
        error: () => {},
        write: () => {},
        setExitCode: () => {},
      },
      values: { json } as never,
      emitJson: (payload: unknown) => jsonPayloads.push(payload),
    },
  };
};

describe("present", () => {
  const rows = [{ id: "a" }, { id: "b" }];
  const lines = (rs: { id: string }[]) => rs.map((r) => `row ${r.id}`);

  test("renders the formatted lines when there are rows", () => {
    const cap = presentCtx(false);
    present(cap.ctx, rows, { lines, empty: "nothing" });
    expect(cap.logs).toEqual(["row a", "row b"]);
    expect(cap.jsonPayloads).toEqual([]);
  });

  test("prints the empty state and renders nothing when there are no rows", () => {
    const cap = presentCtx(false);
    present(cap.ctx, [], { lines, empty: "nothing" });
    expect(cap.logs).toEqual(["nothing"]);
  });

  test("--json emits the rows and skips both the empty state and the lines", () => {
    const cap = presentCtx(true);
    present(cap.ctx, rows, { lines, empty: "nothing" });
    expect(cap.jsonPayloads).toEqual([rows]);
    expect(cap.logs).toEqual([]);
  });

  test("--json emits an empty array rather than the empty-state prose", () => {
    const cap = presentCtx(true);
    present(cap.ctx, [], { lines, empty: "nothing" });
    expect(cap.jsonPayloads).toEqual([[]]);
    expect(cap.logs).toEqual([]);
  });
});
