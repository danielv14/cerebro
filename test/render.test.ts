import { describe, expect, test } from "bun:test";
import { humanBytes, oneLine, projectName, shortDate, shortId, shortTime } from "../src/render.ts";

// ── Primitives ────────────────────────────────────────────────────────────────
// The shared formatting vocabulary; the per-command listing builders (and their
// pinned-output tests) live with their commands under test/commands/.

describe("humanBytes", () => {
  test("formats bytes, KB, and MB with the expected precision", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(512)).toBe("512 B");
    expect(humanBytes(1024)).toBe("1.0 KB");
    expect(humanBytes(1536)).toBe("1.5 KB");
    expect(humanBytes(1024 * 1024)).toBe("1.0 MB");
    expect(humanBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("oneLine", () => {
  test("collapses internal whitespace and newlines, then trims", () => {
    expect(oneLine("  a\n\t b   c  ")).toBe("a b c");
  });

  test("leaves text at exactly the max length untouched", () => {
    expect(oneLine("abcdefghij", 10)).toBe("abcdefghij");
  });

  test("truncates one char past the max to max-1 chars plus the ellipsis", () => {
    // 11 chars at max 10 -> 9 chars + "…" = 10 visible columns.
    expect(oneLine("abcdefghijk", 10)).toBe("abcdefghi…");
  });
});

describe("shortTime", () => {
  test("renders a winter (CET) timestamp in Europe/Stockholm wall-clock", () => {
    // 08:00 UTC + 1h (CET) = 09:00.
    expect(shortTime("2026-01-15T08:00:00Z")).toBe("2026-01-15 09:00");
  });

  test("renders a summer (CEST) timestamp in Europe/Stockholm wall-clock", () => {
    // 08:00 UTC + 2h (CEST) = 10:00.
    expect(shortTime("2026-07-15T08:00:00Z")).toBe("2026-07-15 10:00");
  });

  test("falls back for null, empty, and unparseable input", () => {
    expect(shortTime(null)).toBe("????-??-?? ??:??");
    expect(shortTime(undefined)).toBe("????-??-?? ??:??");
    expect(shortTime("")).toBe("????-??-?? ??:??");
    expect(shortTime("not-a-date")).toBe("????-??-?? ??:??");
  });
});

describe("shortDate", () => {
  test("renders the date in Europe/Stockholm for both DST regimes", () => {
    expect(shortDate("2026-01-15T08:00:00Z")).toBe("2026-01-15");
    expect(shortDate("2026-07-15T08:00:00Z")).toBe("2026-07-15");
  });

  test("falls back for null, empty, and unparseable input", () => {
    expect(shortDate(null)).toBe("??????????");
    expect(shortDate(undefined)).toBe("??????????");
    expect(shortDate("")).toBe("??????????");
    expect(shortDate("not-a-date")).toBe("??????????");
  });
});

describe("projectName", () => {
  test("returns the last path segment", () => {
    expect(projectName("/Users/foo/dev/cerebro")).toBe("cerebro");
  });

  test("ignores a trailing slash", () => {
    expect(projectName("/Users/foo/dev/cerebro/")).toBe("cerebro");
  });

  test("falls back to (unknown) for null", () => {
    expect(projectName(null)).toBe("(unknown)");
  });
});

describe("shortId", () => {
  test("keeps the first eight characters", () => {
    expect(shortId("0123456789abcdef")).toBe("01234567");
  });
});
