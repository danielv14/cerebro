import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db.ts";
import {
  buildDigestInput,
  countStaleThreads,
  DIGEST_PROMPT,
  DIGEST_PROMPT_SIGNATURE,
  DIGEST_PROMPT_VERSION,
  digestModelConfig,
  getSummary,
  pickDigestModel,
  rejectSummaryReason,
  searchSummaries,
  staleThreads,
  writeSummary,
} from "../src/digest.ts";
import { runIndex } from "../src/indexer.ts";
import { relevantThreads, searchSummaryRoots } from "../src/query.ts";
import {
  appendRaw,
  assistantMsg,
  makeClaudeDir,
  type TempClaude,
  ts,
  userMsg,
  writeSession,
} from "./fixtures.ts";

describe("DIGEST_PROMPT", () => {
  test("is a substantial prompt that asks for a Keywords line and covers routine sessions", () => {
    expect(DIGEST_PROMPT.length).toBeGreaterThan(400);
    expect(DIGEST_PROMPT).toContain("Keywords:");
    expect(DIGEST_PROMPT.toLowerCase()).toContain("routine");
    expect(DIGEST_PROMPT.toLowerCase()).toContain("output only the summary");
  });

  test("instructs a deterministic marker for empty/non-substantive sessions", () => {
    expect(DIGEST_PROMPT).toContain("(No substantive session content.)");
    expect(DIGEST_PROMPT.toLowerCase()).toContain("do not ask for a transcript");
  });

  test("opens with the exact signature the indexer keys digest-transcript skipping on", () => {
    // The signature is a persisted contract: transcripts already on disk begin with
    // these bytes, and isDigestRunTranscript matches on the prefix. This guards the
    // template-literal composition after the constant moved to its own leaf module.
    expect(DIGEST_PROMPT.startsWith(DIGEST_PROMPT_SIGNATURE)).toBe(true);
  });
});

describe("rejectSummaryReason (digest write guard)", () => {
  test("accepts a normal summary", () => {
    expect(
      rejectSummaryReason("Fixed the auth middleware in api-server. Keywords: auth, middleware"),
    ).toBeNull();
  });

  test("accepts the mandated empty-session form", () => {
    expect(rejectSummaryReason("(No substantive session content.)\nKeywords: (none)")).toBeNull();
  });

  test("rejects fragments below the minimum length", () => {
    expect(rejectSummaryReason("ok")).toMatch(/too short/);
  });

  test("rejects known failure output regardless of exit-code guards upstream", () => {
    expect(rejectSummaryReason("Prompt is too long for the selected model")).toMatch(
      /error message/,
    );
    expect(rejectSummaryReason("API Error: 429 rate_limit_error something")).toMatch(
      /error message/,
    );
    expect(rejectSummaryReason("Error: something broke in the CLI runner")).toMatch(
      /error message/,
    );
  });

  test("does not reject a summary that merely mentions an error mid-text", () => {
    expect(
      rejectSummaryReason("Debugged an API error in checkout; the fix was a retry. Keywords: api"),
    ).toBeNull();
  });
});

describe("pickDigestModel (size -> model tiering)", () => {
  const config = { small: "small-model", large: "large-model", thresholdChars: 1000 };

  test("a thread below the threshold gets the small model", () => {
    expect(pickDigestModel(999, config)).toBe("small-model");
  });

  test("a thread exactly at the threshold stays on the small model (strict >)", () => {
    expect(pickDigestModel(1000, config)).toBe("small-model");
  });

  test("a thread above the threshold escalates to the large model", () => {
    expect(pickDigestModel(1001, config)).toBe("large-model");
  });
});

describe("digestModelConfig (env overrides)", () => {
  const keys = [
    "CEREBRO_DIGEST_MODEL",
    "CEREBRO_DIGEST_MODEL_LARGE",
    "CEREBRO_DIGEST_HAIKU_MAX_CHARS",
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("defaults to the token-derived threshold", () => {
    // (SMALL_MODEL_CONTEXT_TOKENS 200k - RESERVED_CONTEXT_TOKENS 90k) * BYTES_PER_TOKEN 3.
    // Leaves room for claude -p's ~77k-token system-prompt/tools overhead so a thread
    // that fits on size also fits the real request.
    expect(digestModelConfig()).toEqual({
      small: "claude-haiku-4-5",
      large: "claude-sonnet-4-6[1m]",
      thresholdChars: 330_000,
    });
  });

  test("a dense thread that overflowed Haiku now escalates", () => {
    // Regression: a ~535k-byte thread rendered to ~136k transcript tokens but the
    // request reached ~213k tokens once claude -p added its overhead, overflowing
    // Haiku's 200k window. The old 540k-char threshold kept it on Haiku; the
    // token-derived 330k threshold escalates it to the large model.
    expect(pickDigestModel(535_524, digestModelConfig())).toBe("claude-sonnet-4-6[1m]");
  });

  test("env vars override each field", () => {
    process.env.CEREBRO_DIGEST_MODEL = "tiny";
    process.env.CEREBRO_DIGEST_MODEL_LARGE = "huge";
    process.env.CEREBRO_DIGEST_HAIKU_MAX_CHARS = "12345";
    expect(digestModelConfig()).toEqual({ small: "tiny", large: "huge", thresholdChars: 12_345 });
  });
});

describe("buildDigestInput (size-bounded transcript)", () => {
  const msg = (role: string, text: string, sidechain = false) => ({
    role,
    text,
    ts: "2026-01-01T00:00:00.000Z",
    is_sidechain: sidechain ? 1 : 0,
  });

  test("renders every message verbatim when under budget", () => {
    const out = buildDigestInput([msg("user", "hello there"), msg("assistant", "general kenobi")]);
    expect(out).toContain("hello there");
    expect(out).toContain("general kenobi");
    expect(out).toContain("──── user");
    expect(out).toContain("──── assistant");
    expect(out).not.toContain("truncated for digest");
  });

  test("tags subagent turns in the header", () => {
    const out = buildDigestInput([msg("user", "sub work", true)]);
    expect(out).toContain("──── user · subagent");
  });

  test("over budget: keeps every message, trims the longest, leaves short ones whole", () => {
    const big = "x".repeat(10_000);
    const messages = [
      msg("user", "tiny steer one"),
      msg("assistant", big),
      msg("user", "tiny steer two"),
      msg("assistant", big),
    ];
    const out = buildDigestInput(messages, 2_000);

    // All four messages are still represented (water-fill keeps the conversation shape).
    expect((out.match(/──── /g) ?? []).length).toBe(4);
    // Short steering messages survive intact.
    expect(out).toContain("tiny steer one");
    expect(out).toContain("tiny steer two");
    // The long essays are trimmed, not dropped.
    expect(out).toContain("truncated for digest");
    // Bounded near the budget (marker overhead aside), far below the ~20k verbatim size.
    expect(out.length).toBeLessThan(2_500);
    expect(out.length).toBeGreaterThan(500);
  });

  test("over budget: a long body is capped while a short body is not", () => {
    const out = buildDigestInput(
      [msg("user", "short"), msg("assistant", "y".repeat(5_000))],
      1_000,
    );
    // The short body renders whole (its block ends, then the next header begins).
    expect(out).toContain("short\n\n──── assistant");
    // Only the long body carries the truncation marker.
    expect(out).toContain("truncated for digest");
  });

  test("handles an empty thread", () => {
    expect(buildDigestInput([])).toBe("");
  });
});

describe("digest (summaries layer)", () => {
  let env: TempClaude;
  let db: Database;

  beforeEach(() => {
    env = makeClaudeDir();
    process.env.CEREBRO_CLAUDE_DIR = env.claudeRoot;
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
    env.cleanup();
  });

  test("staleThreads lists never-summarized threads, then excludes summarized ones", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "do the thing", { timestamp: ts(0) }),
      assistantMsg("S", "a1", "done", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    runIndex(db);

    const before = staleThreads(db);
    expect(before.map((t) => t.id)).toEqual(["S"]);
    expect(before[0]!.summary_version).toBeNull();

    writeSummary(db, "S", "Summary of S. Keywords: thing");
    expect(staleThreads(db).length).toBe(0);
  });

  test("a thread with no indexed messages is never stale (nothing to summarize)", () => {
    // A real thread proves the filter is selective, not a blanket exclusion.
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "real work", { timestamp: ts(0) }),
    ]);
    runIndex(db);

    // A session that indexed into a sessions row but contributed no messages
    // (e.g. a /clear-only or resume-marker session): rolls up to msgs = 0 in the
    // threads view, so there is nothing to summarize. Feeding its empty transcript
    // to the model used to produce a "please paste the transcript" non-summary.
    db.run(
      `INSERT INTO sessions (session_id, root_session_id, project_path, msg_count, first_ts, last_ts)
       VALUES ('EMPTY', 'EMPTY', '-repo', 0, ?, ?)`,
      [ts(0), ts(0)],
    );

    expect(staleThreads(db).map((t) => t.id)).toEqual(["S"]);
  });

  test("a thread becomes stale again when new messages arrive after its summary", () => {
    const path = writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "start", { timestamp: ts(0) }),
      assistantMsg("S", "a1", "ok", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    runIndex(db);
    writeSummary(db, "S", "First summary. Keywords: start");
    expect(staleThreads(db).length).toBe(0);

    appendRaw(
      path,
      `${JSON.stringify(
        assistantMsg("S", "a2", "more work later", { parentUuid: "a1", timestamp: ts(100) }),
      )}\n`,
    );
    runIndex(db);

    const stale = staleThreads(db);
    expect(stale.map((t) => t.id)).toEqual(["S"]);
  });

  test("a thread becomes stale when its summary was written by an older prompt version", () => {
    writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "work", { timestamp: ts(0) })]);
    runIndex(db);
    writeSummary(db, "S", "Summary. Keywords: work");
    expect(staleThreads(db).length).toBe(0);

    db.run("UPDATE summaries SET prompt_version = ? WHERE root_session_id = 'S'", [
      DIGEST_PROMPT_VERSION - 1,
    ]);
    const stale = staleThreads(db);
    expect(stale.map((t) => t.id)).toEqual(["S"]);
    expect(stale[0]!.summary_version).toBe(DIGEST_PROMPT_VERSION - 1);
  });

  test("writeSummary upserts: re-summarizing replaces the row and the FTS text", () => {
    writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "work", { timestamp: ts(0) })]);
    runIndex(db);

    writeSummary(db, "S", "First version migrating to drizzle. Keywords: drizzle");
    expect(searchSummaries(db, "drizzle").map((h) => h.id)).toEqual(["S"]);

    writeSummary(db, "S", "Second version migrating to knex. Keywords: knex");
    expect(getSummary(db, "S")!.summary).toContain("knex");
    expect((db.query("SELECT COUNT(*) AS c FROM summaries").get() as { c: number }).c).toBe(1);
    // The old text is gone from the index, the new text is searchable.
    expect(searchSummaries(db, "drizzle").length).toBe(0);
    expect(searchSummaries(db, "knex").map((h) => h.id)).toEqual(["S"]);
  });

  test("writeSummary attributes a resume's summary to the thread root", () => {
    writeSession(env.projects, "-repo", "ORIG", [
      userMsg("ORIG", "u1", "start", { timestamp: ts(0) }),
      assistantMsg("ORIG", "a1", "ok", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    writeSession(env.projects, "-repo", "RESUME", [
      userMsg("RESUME", "u2", "more", { parentUuid: "a1", timestamp: ts(2) }),
    ]);
    runIndex(db);

    const root = writeSummary(db, "RESUME", "Thread summary. Keywords: start, more");
    expect(root).toBe("ORIG");
    expect(getSummary(db, "ORIG")!.summary).toContain("Thread summary");
    // The whole thread now counts as summarized.
    expect(staleThreads(db).length).toBe(0);
  });

  test("searchSummaries ranks by topic, brackets the match, and ignores stopword queries", () => {
    writeSession(env.projects, "-repo-a", "A", [userMsg("A", "ua", "a", { timestamp: ts(0) })]);
    writeSession(env.projects, "-repo-b", "B", [userMsg("B", "ub", "b", { timestamp: ts(10) })]);
    runIndex(db);
    writeSummary(db, "A", "Set up the rate limiter middleware. Keywords: rate-limiter");
    writeSummary(db, "B", "Refactor the checkout flow. Keywords: checkout");

    const hits = searchSummaries(db, "how did the rate limiter work");
    expect(hits.map((h) => h.id)).toEqual(["A"]);
    expect(hits[0]!.snippet).toContain("[limiter]");

    expect(searchSummaries(db, "och att den vi kan").length).toBe(0);
  });

  test("searchSummaries orders matches by bm25 (dense summary before a buried one)", () => {
    // Both summaries match "limiter", so this exercises ranking rather than the
    // single-hit filtering the test above covers: the dense, term-heavy summary must
    // outrank the one where the term is buried in filler. Pins the ORDER BY bm25.
    writeSession(env.projects, "-repo-a", "DENSE", [
      userMsg("DENSE", "ua", "a", { timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo-b", "BURIED", [
      userMsg("BURIED", "ub", "b", { timestamp: ts(10) }),
    ]);
    runIndex(db);
    writeSummary(db, "DENSE", "limiter limiter limiter. Keywords: limiter");
    writeSummary(db, "BURIED", `limiter ${"filler ".repeat(200)} Keywords: filler`);

    expect(searchSummaries(db, "limiter").map((h) => h.id)).toEqual(["DENSE", "BURIED"]);
  });

  test("getSummary returns null when nothing is stored", () => {
    writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "work", { timestamp: ts(0) })]);
    runIndex(db);
    expect(getSummary(db, "S")).toBeNull();
  });

  test("countStaleThreads matches the unbounded stale listing", () => {
    writeSession(env.projects, "-repo", "A", [userMsg("A", "ua", "one", { timestamp: ts(0) })]);
    writeSession(env.projects, "-repo", "B", [userMsg("B", "ub", "two", { timestamp: ts(1) })]);
    runIndex(db);
    expect(countStaleThreads(db)).toBe(staleThreads(db, 1000).length);
    writeSummary(db, "A", "Summary of A with enough length. Keywords: a");
    expect(countStaleThreads(db)).toBe(1);
    expect(countStaleThreads(db)).toBe(staleThreads(db, 1000).length);
  });

  test("searchSummaryRoots is the shared seam behind both relevant and digest search", () => {
    writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "work", { timestamp: ts(0) })]);
    runIndex(db);
    writeSummary(db, "S", "Built the rate limiter middleware. Keywords: rate-limiter");

    // The seam returns the matching root with a bracketed snippet at the requested width.
    const roots = searchSummaryRoots(db, '"limiter"', 5, 12);
    expect(roots.map((r) => r.root)).toEqual(["S"]);
    expect(roots[0]!.snippet).toContain("[limiter]");

    // Both callers route through it: the summary surfaces in `relevant` (summary tier)
    // and in `digest search` for the same prompt.
    const relevant = relevantThreads(db, "how did the rate limiter work");
    expect(relevant.map((r) => r.id)).toEqual(["S"]);
    expect(relevant[0]!.fromSummary).toBe(true);
    expect(searchSummaries(db, "how did the rate limiter work").map((h) => h.id)).toEqual(["S"]);
  });
});
