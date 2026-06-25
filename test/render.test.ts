import { describe, expect, test } from "bun:test";
import {
  digestShow,
  dryRunReport,
  humanBytes,
  indexResult,
  noSummaryHint,
  oneLine,
  projectName,
  recentBlock,
  recentContextFooter,
  recentContextIntro,
  relevantBlock,
  relevantContextIntro,
  relevantFooter,
  searchListing,
  sessionsListing,
  shortDate,
  shortId,
  shortTime,
  showFull,
  showOutline,
  staleIds,
  staleListing,
  statsReport,
  summarySaved,
  summarySearchListing,
} from "../src/render.ts";

// ── Primitives ────────────────────────────────────────────────────────────────
// Exported for these direct edge-case tests; cli.ts never imports them (it reaches
// formatting only through the listing builders below).

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

// ── Agent-facing context blocks ───────────────────────────────────────────────
// The bytes the hooks inject into the model, so the exact string (and especially the
// load-bearing guardrail + recall clauses) is pinned. recentBlock / relevantBlock
// compose these; they are also pinned directly here as the external contract.

describe("recent context block", () => {
  test("intro names the repo and carries the ignore-if-unrelated guardrail", () => {
    expect(recentContextIntro("cerebro")).toBe(
      "Recent Claude Code sessions in this repo (cerebro), from the cerebro archive. " +
        "Background only; ignore if unrelated to the current task.",
    );
  });

  test("footer carries the recall instructions", () => {
    expect(recentContextFooter()).toBe(
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

// ── Listing / report builders (the cli-facing interface) ──────────────────────

describe("searchListing", () => {
  test("renders a header + snippet line per hit, then the count footer", () => {
    const lines = searchListing([
      {
        id: 1,
        session_id: "0123456789abcdef",
        ts: "2026-07-15T08:00:00Z",
        role: "user",
        project_path: "/Users/foo/cerebro",
        title: null,
        snippet: "a matched snippet",
      },
    ]);
    expect(lines).toEqual([
      "01234567  2026-07-15 10:00  user       cerebro",
      "    a matched snippet",
      "\n1 hit(s). Open one with: cerebro show <id>",
    ]);
  });

  test("truncates the snippet at 160 columns", () => {
    const lines = searchListing([
      {
        id: 1,
        session_id: "0123456789abcdef",
        ts: "2026-07-15T08:00:00Z",
        role: "user",
        project_path: "/Users/foo/cerebro",
        title: null,
        snippet: "s".repeat(200),
      },
    ]);
    expect(lines[1]).toBe(`    ${"s".repeat(159)}…`);
  });
});

describe("sessionsListing", () => {
  test("renders the thread row plus the title on its own line, truncated at 120", () => {
    const lines = sessionsListing([
      {
        id: "0123456789abcdef",
        last_ts: "2026-07-15T08:00:00Z",
        first_ts: null,
        msgs: 42,
        sessions_in_thread: 1,
        project_path: "/Users/foo/cerebro",
        title: "My thread",
        body_available: 1,
      },
    ]);
    expect(lines).toEqual(["01234567  2026-07-15 10:00    42 msgs  cerebro", "    My thread"]);
  });

  test("appends resume and [body deleted] suffixes and falls back to (untitled)", () => {
    const lines = sessionsListing([
      {
        id: "0123456789abcdef",
        last_ts: "2026-07-15T08:00:00Z",
        first_ts: null,
        msgs: 42,
        sessions_in_thread: 3,
        project_path: "/Users/foo/cerebro",
        title: null,
        body_available: 0,
      },
    ]);
    expect(lines).toEqual([
      "01234567  2026-07-15 10:00    42 msgs  cerebro +2 resume(s)  [body deleted]",
      "    (untitled)",
    ]);
  });
});

describe("recentBlock", () => {
  test("plain branch: human header, msg count shown, opened line, plain footer", () => {
    const lines = recentBlock(
      [
        {
          thread: {
            id: "0123456789abcdef",
            last_ts: "2026-01-15T08:00:00Z",
            first_ts: null,
            msgs: 7,
            sessions_in_thread: 1,
            project_path: "/Users/foo/cerebro",
            title: "Hello world",
            body_available: 1,
          },
          opening: "do the thing",
        },
      ],
      { repoPath: "/Users/foo/cerebro", days: 14, context: false },
    );
    expect(lines).toEqual([
      "Recent sessions in cerebro (last 14 days):",
      "  01234567  2026-01-15     7 msgs  Hello world",
      "      opened: do the thing",
      '\nPull prior context: cerebro show <id>  |  cerebro search "<terms>"',
    ]);
  });

  test("context branch: agent block, msg count hidden, untitled, no opening line", () => {
    const lines = recentBlock(
      [
        {
          thread: {
            id: "0123456789abcdef",
            last_ts: "2026-01-15T08:00:00Z",
            first_ts: null,
            msgs: 7,
            sessions_in_thread: 1,
            project_path: "/repo",
            title: null,
            body_available: 1,
          },
          opening: null,
        },
      ],
      { repoPath: "/repo", days: 14, context: true },
    );
    expect(lines).toEqual([
      recentContextIntro("repo"),
      "  01234567  2026-01-15  (untitled)",
      recentContextFooter(),
    ]);
  });

  test("truncates the title at 90 columns", () => {
    const lines = recentBlock(
      [
        {
          thread: {
            id: "0123456789abcdef",
            last_ts: "2026-01-15T08:00:00Z",
            first_ts: null,
            msgs: 1,
            sessions_in_thread: 1,
            project_path: "/repo",
            title: "x".repeat(100),
            body_available: 1,
          },
          opening: null,
        },
      ],
      { repoPath: "/repo", days: 14, context: true },
    );
    expect(lines[1]).toBe(`  01234567  2026-01-15  ${"x".repeat(89)}…`);
  });
});

describe("relevantBlock", () => {
  test("context branch: agent intro, opened + summary snippet, shared footer", () => {
    const lines = relevantBlock(
      [
        {
          id: "0123456789abcdef",
          last_ts: "2026-01-15T08:00:00Z",
          project_path: "/Users/foo/cerebro",
          title: "Some thread",
          snippet: "matched bit",
          opening: "the opening",
          fromSummary: true,
        },
      ],
      { context: true },
    );
    expect(lines).toEqual([
      relevantContextIntro(),
      "  01234567  2026-01-15  cerebro  Some thread",
      "      opened: the opening",
      "      summary: matched bit",
      relevantFooter(),
    ]);
  });

  test("plain branch: human intro, (unknown)/(untitled), match-tier snippet", () => {
    const lines = relevantBlock(
      [
        {
          id: "0123456789abcdef",
          last_ts: "2026-01-15T08:00:00Z",
          project_path: null,
          title: null,
          snippet: "matched bit",
          opening: null,
          fromSummary: false,
        },
      ],
      { context: false },
    );
    expect(lines).toEqual([
      "Related past sessions:",
      "  01234567  2026-01-15  (unknown)  (untitled)",
      "      match:  matched bit",
      relevantFooter(),
    ]);
  });
});

describe("showOutline", () => {
  test("header, numbered one-line-per-message digest with subagent marker, footer", () => {
    const lines = showOutline("0123456789abcdef", [
      {
        role: "user",
        ts: "2026-01-15T08:00:00Z",
        text: "hello there",
        session_id: "S",
        is_sidechain: 0,
      },
      {
        role: "assistant",
        ts: "2026-01-15T08:00:00Z",
        text: "general kenobi",
        session_id: "S",
        is_sidechain: 1,
      },
    ]);
    expect(lines).toEqual([
      "Thread 01234567  2 message(s)\n",
      "  1. user      2026-01-15 09:00  hello there",
      "  2. assistant 2026-01-15 09:00  [subagent] general kenobi",
      "\nFull transcript: cerebro show <id> --full",
    ]);
  });
});

describe("showFull", () => {
  test("header, then each message verbatim under a separator with blank lines", () => {
    const lines = showFull("0123456789abcdef", [
      {
        role: "user",
        ts: "2026-01-15T08:00:00Z",
        text: "hello there",
        session_id: "S",
        is_sidechain: 0,
      },
      {
        role: "assistant",
        ts: "2026-01-15T08:00:00Z",
        text: "general kenobi",
        session_id: "S",
        is_sidechain: 1,
      },
    ]);
    expect(lines).toEqual([
      "Thread 01234567  2 message(s)\n",
      "──── user · 2026-01-15 09:00 ────",
      "hello there",
      "",
      "──── assistant · subagent · 2026-01-15 09:00 ────",
      "general kenobi",
      "",
    ]);
  });
});

describe("staleListing", () => {
  test("renders each reason, the title line, and the how-to footer", () => {
    const lines = staleListing(
      [
        {
          id: "0123456789abcdef",
          last_ts: "2026-07-15T08:00:00Z",
          first_ts: null,
          msgs: 5,
          project_path: "/Users/foo/cerebro",
          title: "First",
          summary_version: null,
          summarized_at: null,
        },
        {
          id: "abcdef0123456789",
          last_ts: "2026-07-15T08:00:00Z",
          first_ts: null,
          msgs: 9,
          project_path: "/Users/foo/cerebro",
          title: null,
          summary_version: 1,
          summarized_at: "2026-07-01T08:00:00Z",
        },
        {
          id: "deadbeefdeadbeef",
          last_ts: "2026-07-15T08:00:00Z",
          first_ts: null,
          msgs: 120,
          project_path: "/Users/foo/cerebro",
          title: "Third",
          summary_version: 2,
          summarized_at: "2026-07-01T08:00:00Z",
        },
      ],
      { promptVersion: 2 },
    );
    expect(lines).toEqual([
      "01234567  2026-07-15 10:00     5 msgs  cerebro  [never summarized]",
      "    First",
      "abcdef01  2026-07-15 10:00     9 msgs  cerebro  [prompt v1 < v2]",
      "    (untitled)",
      "deadbeef  2026-07-15 10:00   120 msgs  cerebro  [new activity since summary]",
      "    Third",
      "\n3 thread(s) need a summary. Summarize one:\n" +
        '  cerebro digest input <id> | claude -p "$(cerebro digest prompt)" | cerebro digest write <id>',
    ]);
  });
});

describe("staleIds", () => {
  test("returns one full session id per row, nothing else", () => {
    expect(
      staleIds([
        {
          id: "0123456789abcdef",
          last_ts: null,
          first_ts: null,
          msgs: 1,
          project_path: null,
          title: null,
          summary_version: null,
          summarized_at: null,
        },
        {
          id: "abcdef0123456789",
          last_ts: null,
          first_ts: null,
          msgs: 1,
          project_path: null,
          title: null,
          summary_version: null,
          summarized_at: null,
        },
      ]),
    ).toEqual(["0123456789abcdef", "abcdef0123456789"]);
  });
});

describe("summarySearchListing", () => {
  test("renders a header + snippet line per hit, then the count footer", () => {
    const lines = summarySearchListing([
      {
        id: "0123456789abcdef",
        last_ts: "2026-07-15T08:00:00Z",
        project_path: "/Users/foo/cerebro",
        title: "A title",
        snippet: "a snippet",
      },
    ]);
    expect(lines).toEqual([
      "01234567  2026-07-15 10:00  cerebro  A title",
      "    a snippet",
      "\n1 summary hit(s). Open one: cerebro show <id>  |  full summary: cerebro digest show <id>",
    ]);
  });
});

describe("digestShow", () => {
  test("renders the header with model + prompt version, then the body", () => {
    expect(
      digestShow({
        root_session_id: "0123456789abcdef",
        summary: "The summary body.",
        prompt_version: 1,
        model: "claude-haiku-4-5",
        summarized_at: "2026-07-15T08:00:00Z",
        source_last_ts: null,
      }),
    ).toEqual([
      "Summary for thread 01234567  (2026-07-15 10:00, claude-haiku-4-5, prompt v1)\n",
      "The summary body.",
    ]);
  });

  test("omits the model clause when no model was recorded", () => {
    expect(
      digestShow({
        root_session_id: "0123456789abcdef",
        summary: "Body.",
        prompt_version: 1,
        model: null,
        summarized_at: "2026-07-15T08:00:00Z",
        source_last_ts: null,
      })[0],
    ).toBe("Summary for thread 01234567  (2026-07-15 10:00, prompt v1)\n");
  });
});

describe("status lines", () => {
  test("summarySaved names the thread and char count", () => {
    expect(summarySaved("0123456789abcdef", 123)).toBe(
      "Saved summary for thread 01234567 (123 chars).",
    );
  });

  test("noSummaryHint points at the stale backlog", () => {
    expect(noSummaryHint("0123456789abcdef")).toBe(
      "No summary yet for 01234567. Generate the backlog with: cerebro digest stale",
    );
  });
});

describe("indexResult", () => {
  test("reports new messages and files touched", () => {
    expect(indexResult({ newMessages: 7, filesScanned: 3, filesIndexed: 2 })).toEqual([
      "Indexed 7 new message(s) (2/3 files touched).",
    ]);
  });
});

describe("dryRunReport", () => {
  test("normal incremental plan", () => {
    expect(
      dryRunReport({
        full: false,
        filesScanned: 5,
        filesToRead: 2,
        newFiles: 1,
        grownFiles: 1,
        truncatedFiles: 0,
        unchangedFiles: 3,
        newBytes: 2048,
        candidateMessages: 12,
      }),
    ).toEqual([
      "Dry run. Would index:",
      "  New messages:  12",
      "  New bytes:     2.0 KB",
      "  Files:         1 new, 1 grown, 0 truncated, 3 unchanged (skipped)",
      "\nNothing written. Run `cerebro index` to apply.",
    ]);
  });

  test("nothing to index", () => {
    expect(
      dryRunReport({
        full: false,
        filesScanned: 5,
        filesToRead: 0,
        newFiles: 0,
        grownFiles: 0,
        truncatedFiles: 0,
        unchangedFiles: 5,
        newBytes: 0,
        candidateMessages: 0,
      }),
    ).toEqual([
      "Dry run: nothing to index. 5/5 files unchanged.",
      "\nNothing written. Run `cerebro index` to apply.",
    ]);
  });

  test("--full re-read", () => {
    expect(
      dryRunReport({
        full: true,
        filesScanned: 5,
        filesToRead: 5,
        newFiles: 0,
        grownFiles: 0,
        truncatedFiles: 0,
        unchangedFiles: 0,
        newBytes: 1024 * 1024,
        candidateMessages: 100,
      }),
    ).toEqual([
      "Dry run (--full): would re-read all 5 file(s).",
      "  Candidate messages: 100 (before UUID dedup)",
      "  Bytes to read:      1.0 MB",
      "  On an up-to-date archive dedup collapses this to ~0 net-new messages.",
      "\nNothing written. Run `cerebro index` to apply.",
    ]);
  });
});

describe("statsReport", () => {
  test("renders the four archive counts left-aligned to a shared column", () => {
    expect(statsReport({ threads: 4, sessions: 6, messages: 120, deletedSources: 1 })).toEqual([
      "Threads:          4",
      "Sessions:         6",
      "Messages:         120",
      "Deleted sources:  1",
    ]);
  });
});
