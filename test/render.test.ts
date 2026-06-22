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
  recentContextIntro,
  recentContextFooter,
  relevantContextIntro,
  relevantFooter,
  relevantThreadLine,
  relevantSnippetLine,
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

  test("treats the resume and [body deleted] suffixes independently", () => {
    const line = sessionThreadLine({
      id: "0123456789abcdef",
      last_ts: "2026-07-15T08:00:00Z",
      msgs: 42,
      sessions_in_thread: 2,
      project_path: "/Users/foo/cerebro",
      body_available: 1,
    });
    expect(line).toBe("01234567  2026-07-15 10:00    42 msgs  cerebro +1 resume(s)");
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

// The --context blocks are the bytes the hooks inject into the model, so the exact
// string (and especially the load-bearing guardrail + recall clauses) is pinned.
describe("recent context block", () => {
  test("intro names the repo and carries the ignore-if-unrelated guardrail", () => {
    expect(recentContextIntro("cerebro")).toBe(
      "Recent Claude Code sessions in this repo (cerebro), from the cerebro archive. " +
        "Background only; ignore if unrelated to the current task.",
    );
  });

  test("footer carries the recall instructions", () => {
    const footer = recentContextFooter();
    expect(footer).toBe(
      "\nIf the request overlaps with any of these, recall that work instead of starting over:\n" +
        "  cerebro show <id>          thread outline (add --full for the transcript)\n" +
        '  cerebro search "<terms>"   full-text search across all past sessions',
    );
  });
});

describe("relevant context block", () => {
  test("intro carries the ignore-if-unrelated guardrail", () => {
    expect(relevantContextIntro()).toBe(
      "Possibly relevant past Claude Code sessions (from the cerebro archive, matched " +
        "against this prompt). Background only; ignore any that do not actually relate.",
    );
  });

  test("footer carries the recall instructions (shared by both branches)", () => {
    expect(relevantFooter()).toBe(
      "\nTo recall one: cerebro show <id> (add --full for the transcript), " +
        'or cerebro search "<terms>".',
    );
  });
});

describe("relevantThreadLine", () => {
  test("renders id, date, project, and title", () => {
    const line = relevantThreadLine({
      id: "0123456789abcdef",
      last_ts: "2026-01-15T08:00:00Z",
      project_path: "/Users/foo/cerebro",
      title: "Some thread",
    });
    expect(line).toBe("  01234567  2026-01-15  cerebro  Some thread");
  });

  test("falls back to (untitled) and truncates the title at 80 columns", () => {
    const title = "z".repeat(90);
    const line = relevantThreadLine({
      id: "0123456789abcdef",
      last_ts: "2026-01-15T08:00:00Z",
      project_path: "/Users/foo/cerebro",
      title,
    });
    expect(line).toBe(`  01234567  2026-01-15  cerebro  ${"z".repeat(79)}…`);

    const untitled = relevantThreadLine({
      id: "0123456789abcdef",
      last_ts: "2026-01-15T08:00:00Z",
      project_path: null,
      title: null,
    });
    expect(untitled).toBe("  01234567  2026-01-15  (unknown)  (untitled)");
  });
});

describe("relevantSnippetLine", () => {
  test("labels a summary-tier snippet", () => {
    expect(relevantSnippetLine("matched bit", true)).toBe("      summary: matched bit");
  });

  test("labels a raw-transcript-tier snippet", () => {
    expect(relevantSnippetLine("matched bit", false)).toBe("      match:  matched bit");
  });

  test("truncates the snippet at 120 columns", () => {
    const snippet = "w".repeat(130);
    expect(relevantSnippetLine(snippet, false)).toBe(`      match:  ${"w".repeat(119)}…`);
  });
});
