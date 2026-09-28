import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { openDb } from "../../src/db.ts";
import { DIGEST_PROMPT_VERSION } from "../../src/digest/prompt.ts";
import { staleThreads } from "../../src/digest/stale.ts";
import { reattachSummaries } from "../../src/digest/store.ts";

describe("staleListing, through the stale query", () => {
  const NOW = Date.parse("2026-07-15T12:00:00Z");
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  const thread = (id: string, lastTs: string, title: string | null = null, root = id): void => {
    db.run(
      `INSERT INTO sessions (session_id, root_session_id, project_path, title, msg_count, first_ts, last_ts)
       VALUES (?, ?, '/Users/foo/cerebro', ?, 5, ?, ?)`,
      [id, root, title, lastTs, lastTs],
    );
  };

  const summary = (id: string, coversLastTs: string | null, version = DIGEST_PROMPT_VERSION) => {
    db.run(
      `INSERT INTO summaries (root_session_id, summary, prompt_version, summarized_at, source_last_ts)
       VALUES (?, 'A summary of the thread.', ?, '2026-07-01T08:00:00Z', ?)`,
      [id, version, coversLastTs],
    );
  };

  const failure = (id: string, retryAfter: string): void => {
    db.run(
      `INSERT INTO digest_failures (root_session_id, attempts, last_error, failed_at, retry_after)
       VALUES (?, 2, 'boom', '2026-07-15T06:00:00Z', ?)`,
      [id, retryAfter],
    );
  };

  const listing = (): string[] =>
    staleListing(staleThreads(db, { now: NOW }), { promptVersion: DIGEST_PROMPT_VERSION });

  test("each stale reason gets its own label, then the how-to footer", () => {
    thread("aaaaaaaa00000000", "2026-07-15T08:00:00Z", "Never");
    thread("bbbbbbbb00000000", "2026-07-15T07:00:00Z");
    summary("bbbbbbbb00000000", "2026-07-15T07:00:00Z", DIGEST_PROMPT_VERSION - 1);
    thread("cccccccc00000000", "2026-07-15T06:00:00Z", "Grown");
    summary("cccccccc00000000", "2026-07-15T05:00:00Z");
    thread("dddddddd00000000", "2026-07-15T05:00:00Z", "Covered");
    summary("dddddddd00000000", "2026-07-15T05:00:00Z");

    expect(listing()).toEqual([
      "aaaaaaaa  2026-07-15 10:00     5 msgs  cerebro  [never summarized]",
      "    Never",
      `bbbbbbbb  2026-07-15 09:00     5 msgs  cerebro  [prompt v${DIGEST_PROMPT_VERSION - 1} < v${DIGEST_PROMPT_VERSION}]`,
      "    (untitled)",
      "cccccccc  2026-07-15 08:00     5 msgs  cerebro  [new activity since summary]",
      "    Grown",
      "\n3 thread(s) need a summary. Summarize one:\n" +
        "  cerebro digest run <id>          (or drain the backlog: cerebro digest drain --limit N)",
    ]);
  });

  test("a summary moved onto a new root reads as moved, not as new activity", () => {
    thread("root0000aaaaaaaa", "2026-07-15T08:00:00Z", "Thread");
    thread("former00aaaaaaaa", "2026-07-15T07:00:00Z", null, "root0000aaaaaaaa");
    summary("former00aaaaaaaa", "2026-07-15T08:00:00Z");
    reattachSummaries(db);

    expect(listing()[0]).toBe(
      "root0000  2026-07-15 10:00    10 msgs  cerebro  [summary moved from an earlier root]",
    );
  });

  test("the listing marks what a drain holds back, and why", () => {
    thread("backoff0aaaaaaaa", "2026-07-15T08:00:00Z");
    failure("backoff0aaaaaaaa", "2026-07-16T08:00:00Z");
    thread("due00000aaaaaaaa", "2026-07-15T07:00:00Z");
    failure("due00000aaaaaaaa", "2026-07-15T09:00:00Z");
    thread("active00aaaaaaaa", "2026-07-15T11:50:00Z");

    const lines = listing();
    expect(lines[0]).toBe(
      "active00  2026-07-15 13:50     5 msgs  cerebro  " +
        "[never summarized; settling, drain waits until 2026-07-15 14:20]",
    );
    expect(lines[2]).toBe(
      "backoff0  2026-07-15 10:00     5 msgs  cerebro  " +
        "[never summarized; failed 2x, drain retries after 2026-07-16 10:00]",
    );
    expect(lines[4]).toBe(
      "due00000  2026-07-15 09:00     5 msgs  cerebro  [never summarized; failed 2x, next drain retries it]",
    );
    expect(staleThreads(db, { now: NOW, drain: true }).map((row) => row.id)).toEqual([
      "due00000aaaaaaaa",
    ]);
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
          reason: "never",
          hold: null,
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
          reason: "never",
          hold: null,
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
