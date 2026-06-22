import { test, expect, describe } from "bun:test";
import {
  shortId,
  shortTime,
  shortDate,
  projectName,
  oneLine,
  humanBytes,
  recentThreadLine,
  openedLine,
  sessionThreadLine,
} from "../src/render.ts";

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

describe("recentThreadLine", () => {
  test("sessions/recent style with msgs count shown", () => {
    const line = recentThreadLine(
      { id: "0123456789abcdef", last_ts: "2026-01-15T08:00:00Z", msgs: 7, title: "Hello world" },
      { showMsgs: true },
    );
    expect(line).toBe("  01234567  2026-01-15     7 msgs  Hello world");
  });

  test("--context style drops the msgs count and falls back to (untitled)", () => {
    const line = recentThreadLine(
      { id: "0123456789abcdef", last_ts: "2026-01-15T08:00:00Z", msgs: 7, title: null },
      { showMsgs: false },
    );
    expect(line).toBe("  01234567  2026-01-15  (untitled)");
  });

  test("truncates the title at 90 columns", () => {
    const title = "x".repeat(100);
    const line = recentThreadLine(
      { id: "0123456789abcdef", last_ts: "2026-01-15T08:00:00Z", msgs: 1, title },
      { showMsgs: false },
    );
    expect(line).toBe(`  01234567  2026-01-15  ${"x".repeat(89)}…`);
  });
});

describe("sessionThreadLine", () => {
  test("renders id, time, msgs count, and project with no suffixes for a single session", () => {
    const line = sessionThreadLine({
      id: "0123456789abcdef",
      last_ts: "2026-07-15T08:00:00Z",
      msgs: 42,
      sessions_in_thread: 1,
      project_path: "/Users/foo/cerebro",
      body_available: 1,
    });
    expect(line).toBe("01234567  2026-07-15 10:00    42 msgs  cerebro");
  });

  test("appends the resume count and [body deleted] suffixes when present", () => {
    const line = sessionThreadLine({
      id: "0123456789abcdef",
      last_ts: "2026-07-15T08:00:00Z",
      msgs: 42,
      sessions_in_thread: 3,
      project_path: "/Users/foo/cerebro",
      body_available: 0,
    });
    expect(line).toBe("01234567  2026-07-15 10:00    42 msgs  cerebro +2 resume(s)  [body deleted]");
  });
});

describe("openedLine", () => {
  test("prefixes the opening prompt with the six-space opened label", () => {
    expect(openedLine("a prompt")).toBe("      opened: a prompt");
  });

  test("truncates the opening prompt at 120 columns", () => {
    const opening = "y".repeat(130);
    expect(openedLine(opening)).toBe(`      opened: ${"y".repeat(119)}…`);
  });
});
