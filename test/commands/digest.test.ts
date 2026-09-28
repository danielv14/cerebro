import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_DRAIN_LIMIT,
  digestShow,
  drainSummary,
  noSummaryHint,
  staleIds,
  staleListing,
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
          failed_attempts: null,
          retry_after: null,
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
          failed_attempts: null,
          retry_after: null,
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
          failed_attempts: null,
          retry_after: null,
        },
      ],
      { promptVersion: 2, now: 0 },
    );
    expect(lines).toEqual([
      "01234567  2026-07-15 10:00     5 msgs  cerebro  [never summarized]",
      "    First",
      "abcdef01  2026-07-15 10:00     9 msgs  cerebro  [prompt v1 < v2]",
      "    (untitled)",
      "deadbeef  2026-07-15 10:00   120 msgs  cerebro  [new activity since summary]",
      "    Third",
      "\n3 thread(s) need a summary. Summarize one:\n" +
        "  cerebro digest run <id>          (or drain the backlog: cerebro digest drain --limit N)",
    ]);
  });
});

describe("staleListing failures (#205)", () => {
  test("a thread with failed attempts carries the count and the next drain retry", () => {
    const [line] = staleListing(
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
          failed_attempts: 2,
          retry_after: "2026-07-16T08:00:00Z",
        },
      ],
      { promptVersion: 1, now: Date.parse("2026-07-15T12:00:00Z") },
    );
    expect(line).toBe(
      "01234567  2026-07-15 10:00     5 msgs  cerebro  " +
        "[never summarized; failed 2x, drain retries after 2026-07-16 10:00]",
    );
  });

  test("a retry time already past reads as due, not as a wait", () => {
    const [line] = staleListing(
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
          failed_attempts: 1,
          retry_after: "2026-07-15T09:00:00Z",
        },
      ],
      { promptVersion: 1, now: Date.parse("2026-07-15T12:00:00Z") },
    );
    expect(line).toContain("[never summarized; failed 1x, next drain retries it]");
  });
});

describe("drainSummary", () => {
  const empty = { outcomes: [], summarized: 0, failed: 0, skipped: 0 };

  test("an empty drain with nothing held back reports a clean backlog", () => {
    expect(drainSummary({ ...empty, heldBack: 0 })).toEqual([
      "Nothing stale, the backlog is clean.",
    ]);
  });

  test("an empty drain that left threads for later says so rather than claiming clean", () => {
    expect(drainSummary({ ...empty, heldBack: 3 })).toEqual([
      "Nothing to drain now: 3 stale thread(s) still active or backing off after a failure " +
        "(see cerebro digest stale).",
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
          failed_attempts: null,
          retry_after: null,
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
          failed_attempts: null,
          retry_after: null,
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
        provider: "claude-code",
        model: null,
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
  test("noSummaryHint points at the stale backlog", () => {
    expect(noSummaryHint("0123456789abcdef")).toBe(
      "No summary yet for 01234567. Generate the backlog with: cerebro digest stale",
    );
  });
});

test("digest drain defaults to the batch hook's cap", () => {
  const hook = readFileSync(
    join(import.meta.dir, "..", "..", "hooks", "digest-stale-batch.sh"),
    "utf8",
  );
  expect(hook).toContain(`CAP="\${CEREBRO_DIGEST_BATCH_CAP:-${DEFAULT_DRAIN_LIMIT}}"`);
});
