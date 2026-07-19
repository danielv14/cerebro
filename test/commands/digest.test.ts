import { describe, expect, test } from "bun:test";
import {
  digestShow,
  noSummaryHint,
  staleIds,
  staleListing,
  summarySaved,
  summarySearchListing,
} from "../../src/commands/digest.ts";

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
