import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { openDb } from "../src/db.ts";
import { searchSummaries, writeSummary } from "../src/digest/index.ts";
import { runIndex } from "../src/indexer.ts";
import {
  listThreads,
  recentThreads,
  resolveSession,
  search,
  stats,
  toMatchQuery,
} from "../src/query.ts";
import { relevantThreads } from "../src/relevance.ts";
import { countThreads, rootOf, threadMessages } from "../src/thread.ts";
import {
  assistantMsg,
  makeClaudeDir,
  type TempClaude,
  ts,
  userMsg,
  writeSession,
  writeSubagent,
} from "./fixtures.ts";

describe("toMatchQuery", () => {
  test("builds an OR-of-tokens query and drops stopwords", () => {
    expect(toMatchQuery("hur fungerar cerebro indexering")).toBe(
      '"fungerar" OR "cerebro" OR "indexering"',
    );
  });

  test("returns null when the prompt is all stopwords", () => {
    expect(toMatchQuery("och att den vi kan")).toBeNull();
  });

  test("returns null for empty / punctuation-only input", () => {
    expect(toMatchQuery("")).toBeNull();
    expect(toMatchQuery("   ... !!!")).toBeNull();
  });

  test("dedupes repeated tokens", () => {
    expect(toMatchQuery("drizzle drizzle drizzle")).toBe('"drizzle"');
  });
});

describe("query (populated archive)", () => {
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

  test("search returns ranked hits with a highlighted snippet", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "add a token bucket rate limiter to the middleware"),
      assistantMsg("S", "a1", "unrelated text about colors", { parentUuid: "u1" }),
    ]);
    runIndex(db);
    const hits = search(db, "limiter", 10);
    expect(hits.length).toBe(1);
    expect(hits[0]!.session_id).toBe("S");
    expect(hits[0]!.snippet).toContain("[limiter]");
  });

  test("search orders hits by bm25 relevance (dense match before a buried one)", () => {
    // DENSE: the term dominates a short message. BURIED: one occurrence drowned in
    // filler. bm25 ranks the dense, shorter document higher; this pins the ORDER BY
    // so a regression that drops or reverses it is caught (every other search test
    // has a single hit and would stay green regardless of ordering).
    writeSession(env.projects, "-repo", "DENSE", [
      userMsg("DENSE", "u1", "limiter limiter limiter", { timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo", "BURIED", [
      userMsg("BURIED", "u2", `limiter ${"filler ".repeat(200)}`, { timestamp: ts(10) }),
    ]);
    runIndex(db);
    const hits = search(db, "limiter", 10);
    expect(hits.map((h) => h.session_id)).toEqual(["DENSE", "BURIED"]);
  });

  test("search caps results at the limit, keeping the most relevant", () => {
    writeSession(env.projects, "-repo", "TOP", [
      userMsg("TOP", "u1", "limiter limiter limiter", { timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo", "MID", [
      userMsg("MID", "u2", `limiter ${"filler ".repeat(100)}`, { timestamp: ts(10) }),
    ]);
    writeSession(env.projects, "-repo", "LOW", [
      userMsg("LOW", "u3", `limiter ${"filler ".repeat(400)}`, { timestamp: ts(20) }),
    ]);
    runIndex(db);
    const hits = search(db, "limiter", 2);
    // Three documents match, but limit=2 truncates to the two best by bm25.
    expect(hits.map((h) => h.session_id)).toEqual(["TOP", "MID"]);
  });

  test("search returns the best hit per thread by default, --all returns every message (#53)", () => {
    writeSession(env.projects, "-repo", "CHATTY", [
      userMsg("CHATTY", "u1", "limiter limiter limiter", { timestamp: ts(0) }),
      assistantMsg("CHATTY", "a1", "limiter limiter", { parentUuid: "u1", timestamp: ts(1) }),
      userMsg("CHATTY", "u2", "more about the limiter", { parentUuid: "a1", timestamp: ts(2) }),
    ]);
    writeSession(env.projects, "-repo", "OTHER", [
      userMsg("OTHER", "u3", `limiter ${"filler ".repeat(50)}`, { timestamp: ts(10) }),
    ]);
    runIndex(db);
    // Default: one (best) hit per thread, so OTHER is not buried by CHATTY.
    const deduped = search(db, "limiter", 10);
    expect(deduped.map((h) => h.session_id).sort()).toEqual(["CHATTY", "OTHER"]);
    // --all: every matching message.
    const all = search(db, "limiter", 10, { all: true });
    expect(all.length).toBe(4);
  });

  test("search --project and --since scope the hits (#53)", () => {
    writeSession(env.projects, "-repo-a", "A", [
      userMsg("A", "u1", "limiter in alpha", { cwd: "/home/user/alpha", timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo-b", "B", [
      userMsg("B", "u2", "limiter in beta", { cwd: "/home/user/beta", timestamp: ts(100) }),
    ]);
    runIndex(db);
    expect(search(db, "limiter", 10, { project: "alpha" }).map((h) => h.session_id)).toEqual(["A"]);
    expect(search(db, "limiter", 10, { since: ts(50) }).map((h) => h.session_id)).toEqual(["B"]);
    expect(search(db, "limiter", 10).length).toBe(2);
  });

  test("search --project keeps a resume whose own project_path is NULL (#86)", () => {
    // The root carries the cwd; the resume's lines omit it, so its session row has a
    // NULL project_path. Filtering on the session would drop the resume's hit even
    // though the thread belongs to alpha.
    writeSession(env.projects, "-repo-a", "ROOT", [
      userMsg("ROOT", "r1", "zebra in the root", { cwd: "/home/user/alpha", timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo-a", "RESUME", [
      userMsg("RESUME", "r2", "zebra in the resume", {
        cwd: undefined,
        parentUuid: "r1",
        timestamp: ts(10),
      }),
    ]);
    runIndex(db);
    expect(
      search(db, "zebra", 10, { all: true })
        .map((h) => h.session_id)
        .sort(),
    ).toEqual(["RESUME", "ROOT"]);
    expect(
      search(db, "zebra", 10, { all: true, project: "alpha" })
        .map((h) => h.session_id)
        .sort(),
    ).toEqual(["RESUME", "ROOT"]);
  });

  test("search --project keeps a resume whose cwd points at another project (#86)", () => {
    writeSession(env.projects, "-repo-a", "ROOT", [
      userMsg("ROOT", "r1", "zebra in the root", { cwd: "/home/user/alpha", timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo-a", "RESUME", [
      userMsg("RESUME", "r2", "zebra in a worktree", {
        cwd: "/home/user/worktrees/alpha-fix",
        parentUuid: "r1",
        timestamp: ts(10),
      }),
    ]);
    runIndex(db);
    // The thread's representative project_path is the root's, so both hits match.
    expect(
      search(db, "zebra", 10, { all: true, project: "user/alpha" })
        .map((h) => h.session_id)
        .sort(),
    ).toEqual(["RESUME", "ROOT"]);
  });

  test("search --branch scopes hits to threads recorded on the branch, by substring", () => {
    // The fixture default branch is "main"; FEAT overrides it.
    writeSession(env.projects, "-repo", "MAIN", [
      userMsg("MAIN", "u1", "limiter on main", { timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo", "FEAT", [
      userMsg("FEAT", "u2", "limiter on the feature branch", {
        gitBranch: "feat/limiter",
        timestamp: ts(10),
      }),
    ]);
    runIndex(db);
    expect(search(db, "limiter", 10, { branch: "feat/limiter" }).map((h) => h.session_id)).toEqual([
      "FEAT",
    ]);
    expect(search(db, "limiter", 10, { branch: "feat" }).map((h) => h.session_id)).toEqual([
      "FEAT",
    ]);
    expect(search(db, "limiter", 10).length).toBe(2);
    // The hit carries its own session's branch.
    expect(search(db, "limiter", 10, { branch: "feat" })[0]!.git_branch).toBe("feat/limiter");
  });

  test("search --branch matches the whole thread when only a resume carries the branch", () => {
    writeSession(env.projects, "-repo", "ROOT", [
      userMsg("ROOT", "r1", "zebra in the root", { timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo", "RESUME", [
      userMsg("RESUME", "r2", "zebra in the resume", {
        gitBranch: "feat/zebra",
        parentUuid: "r1",
        timestamp: ts(10),
      }),
    ]);
    runIndex(db);
    // Any-session semantics: the root's hit (recorded on main) matches too, because
    // the thread touched the branch in its resume.
    expect(
      search(db, "zebra", 10, { all: true, branch: "feat/zebra" })
        .map((h) => h.session_id)
        .sort(),
    ).toEqual(["RESUME", "ROOT"]);
  });

  test("search --role and --prose cut tool plumbing out of the hits (#87)", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "how do we handle the limiter", { timestamp: ts(0) }),
      assistantMsg("S", "a1", "the limiter is rate-based", { parentUuid: "u1", timestamp: ts(1) }),
      assistantMsg(
        "S",
        "a2",
        [{ type: "tool_use", name: "Bash", input: { command: "grep limiter src" } }],
        { parentUuid: "a1", timestamp: ts(2) },
      ),
      userMsg("S", "u2", [{ type: "tool_result", content: "src/limiter.ts:1" }], {
        parentUuid: "a2",
        timestamp: ts(3),
      }),
    ]);
    runIndex(db);
    const ids = (opts: Parameters<typeof search>[3]) =>
      search(db, "limiter", 10, { all: true, ...opts })
        .map((h) => h.id)
        .sort((a, b) => a - b);
    const [prose1, prose2, toolUse, toolResult] = ids({});
    expect([prose1, prose2, toolUse, toolResult]).toHaveLength(4);
    expect(ids({ role: "user" })).toEqual([prose1!, toolResult!]);
    expect(ids({ role: "assistant" })).toEqual([prose2!, toolUse!]);
    expect(ids({ prose: true })).toEqual([prose1!, prose2!]);
    // The "only my own prompts" query: a tool_result is a user turn, so --role user
    // alone is not enough.
    expect(ids({ role: "user", prose: true })).toEqual([prose1!]);
  });

  test("search --prose keeps a message that opens with prose and then calls a tool (#87)", () => {
    writeSession(env.projects, "-repo", "S", [
      assistantMsg(
        "S",
        "a1",
        [
          { type: "text", text: "Checking the limiter now." },
          { type: "tool_use", name: "Bash", input: { command: "grep limiter src" } },
        ],
        { timestamp: ts(0) },
      ),
    ]);
    runIndex(db);
    expect(search(db, "limiter", 10, { all: true, prose: true })).toHaveLength(1);
  });

  test("deduped search looks past a chatty thread that dominates the ranked hits", () => {
    // 210 matching messages in one thread outrank the other thread's single match.
    // A 200-row window would starve OTHER; the 2000-row over-fetch surfaces it in one
    // fetch, without growing.
    const chatty = Array.from({ length: 210 }, (_, i) =>
      userMsg("CHATTY", `c${i}`, "limiter limiter limiter", {
        timestamp: ts(i),
        parentUuid: i === 0 ? null : `c${i - 1}`,
      }),
    );
    writeSession(env.projects, "-repo", "CHATTY", chatty);
    writeSession(env.projects, "-repo", "OTHER", [
      userMsg("OTHER", "o1", `limiter ${"filler ".repeat(80)}`, { timestamp: ts(1000) }),
    ]);
    runIndex(db);
    const hits = search(db, "limiter", 5);
    expect(hits.map((h) => h.session_id).sort()).toEqual(["CHATTY", "OTHER"]);
  });

  test("deduped search grows the over-fetch window when the first one is exhausted (#81)", () => {
    // A chatty thread wider than the initial 2000-row window owns every row of the
    // first fetch, so the deeper re-fetch (window *= 4) is the only way OTHER surfaces.
    const chatty = Array.from({ length: 2100 }, (_, i) =>
      userMsg("CHATTY", `c${i}`, "limiter limiter limiter", {
        timestamp: ts(i),
        parentUuid: i === 0 ? null : `c${i - 1}`,
      }),
    );
    writeSession(env.projects, "-repo", "CHATTY", chatty);
    writeSession(env.projects, "-repo", "OTHER", [
      userMsg("OTHER", "o1", `limiter ${"filler ".repeat(80)}`, { timestamp: ts(5000) }),
    ]);
    runIndex(db);
    const hits = search(db, "limiter", 2);
    expect(hits.map((h) => h.session_id).sort()).toEqual(["CHATTY", "OTHER"]);
  });

  test("search hits carry the thread ordinal matching show's numbering (#58)", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "opening prompt", { timestamp: ts(0) }),
      assistantMsg("S", "a1", "the limiter answer", { parentUuid: "u1", timestamp: ts(1) }),
      userMsg("S", "u2", "closing note", { parentUuid: "a1", timestamp: ts(2) }),
    ]);
    runIndex(db);
    const hits = search(db, "limiter", 10);
    expect(hits.length).toBe(1);
    expect(hits[0]!.ordinal).toBe(2); // second message in the thread's chronology
  });

  test("search recovers from a malformed FTS query via the sanitized fallback", () => {
    // A bare unbalanced quote is invalid FTS5 (`unterminated string`) and throws on
    // the verbatim MATCH. The catch re-runs the query as a sanitized phrase of the
    // bare tokens, so a fat-fingered query still returns its hit instead of erroring.
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "alpha beta gamma", { timestamp: ts(0) }),
    ]);
    runIndex(db);
    const hits = search(db, 'alpha"', 10);
    expect(hits.map((h) => h.session_id)).toEqual(["S"]);
  });

  test("search returns no hits when a malformed query sanitizes to nothing matchable", () => {
    // The fallback must also fail soft: a punctuation-only query throws on the raw
    // MATCH, sanitizes to a phrase with no tokens, and yields [] rather than throwing.
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "alpha beta", { timestamp: ts(0) }),
    ]);
    runIndex(db);
    expect(search(db, '"""', 10)).toEqual([]);
  });

  test("listThreads lists roots newest-first and filters by project after grouping", () => {
    writeSession(env.projects, "-repo-a", "A", [
      userMsg("A", "ua", "alpha", { cwd: "/repo-a", timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo-b", "B", [
      userMsg("B", "ub", "beta", { cwd: "/repo-b", timestamp: ts(10) }),
    ]);
    runIndex(db);
    const all = listThreads(db, {});
    expect(all.length).toBe(2);
    expect(all[0]!.id).toBe("B"); // newest first

    const filtered = listThreads(db, { project: "repo-a" });
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.id).toBe("A");
  });

  test("listThreads --since filters on the thread's last activity, inclusively (#91)", () => {
    writeSession(env.projects, "-repo", "OLD", [
      userMsg("OLD", "u1", "old", { timestamp: "2026-01-10T12:00:00.000Z" }),
    ]);
    writeSession(env.projects, "-repo", "CUTOFF", [
      userMsg("CUTOFF", "u2", "on the cutoff", { timestamp: "2026-02-01T00:00:00.000Z" }),
    ]);
    writeSession(env.projects, "-repo", "NEW", [
      userMsg("NEW", "u3", "new", { timestamp: "2026-03-05T12:00:00.000Z" }),
    ]);
    runIndex(db);
    expect(listThreads(db, { since: "2026-02-01" }).map((t) => t.id)).toEqual(["NEW", "CUTOFF"]);
    expect(listThreads(db, { since: "2026-04-01" })).toEqual([]);
    // Combines with --project rather than replacing it.
    expect(listThreads(db, { since: "2026-02-01", project: "nope" })).toEqual([]);
    expect(listThreads(db, {}).length).toBe(3);
  });

  test("listThreads --branch matches any session in the thread; the row shows the root's", () => {
    writeSession(env.projects, "-repo", "ROOT", [
      userMsg("ROOT", "u1", "start", { timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo", "RESUME", [
      userMsg("RESUME", "u2", "more", {
        gitBranch: "feat/x",
        parentUuid: "u1",
        timestamp: ts(1),
      }),
    ]);
    writeSession(env.projects, "-repo", "OTHER", [
      userMsg("OTHER", "u3", "elsewhere", { timestamp: ts(2) }),
    ]);
    runIndex(db);
    const hits = listThreads(db, { branch: "feat/x" });
    expect(hits.map((t) => t.id)).toEqual(["ROOT"]);
    // Display is root-preferring even though the match came from the resume.
    expect(hits[0]!.git_branch).toBe("main");
    expect(
      listThreads(db, { branch: "main" })
        .map((t) => t.id)
        .sort(),
    ).toEqual(["OTHER", "ROOT"]);
  });

  test("search --branch and sessions --branch agree on which threads touch a branch (#123)", () => {
    // Both readers compose threadOnBranch now; before, the same any-session rule was
    // spelled as two different subqueries and only a comment said they matched.
    writeSession(env.projects, "-repo", "ROOT", [
      userMsg("ROOT", "u1", "the limiter work", { timestamp: ts(0) }),
    ]);
    writeSession(env.projects, "-repo", "RESUME", [
      userMsg("RESUME", "u2", "more limiter work", {
        gitBranch: "feat/x",
        parentUuid: "u1",
        timestamp: ts(1),
      }),
    ]);
    writeSession(env.projects, "-repo", "OTHER", [
      userMsg("OTHER", "u3", "limiter elsewhere", { timestamp: ts(2) }),
    ]);
    runIndex(db);

    const searched = (branch: string): string[] =>
      [
        ...new Set(
          search(db, "limiter", 20, { all: true, branch }).map((hit) => rootOf(db, hit.session_id)),
        ),
      ].sort();
    const listed = (branch: string): string[] =>
      listThreads(db, { branch })
        .map((thread) => thread.id)
        .sort();

    // "feat/x" is the interesting one: only the resume carries it, so the rule has to
    // reach the whole thread from either side.
    for (const branch of ["feat/x", "feat", "main", "nope"]) {
      expect({ branch, roots: searched(branch) }).toEqual({ branch, roots: listed(branch) });
    }
    expect(listed("feat/x")).toEqual(["ROOT"]);
    expect(listed("main")).toEqual(["OTHER", "ROOT"]);
    expect(listed("nope")).toEqual([]);
  });

  test("listThreads aggregates a resume's messages into the thread total", () => {
    writeSession(env.projects, "-repo", "ORIG", [
      userMsg("ORIG", "u1", "start", { cwd: "/repo", timestamp: ts(0) }),
      assistantMsg("ORIG", "a1", "ok", { cwd: "/repo", parentUuid: "u1", timestamp: ts(1) }),
    ]);
    writeSession(env.projects, "-repo", "RESUME", [
      userMsg("RESUME", "u2", "more", { cwd: "/repo", parentUuid: "a1", timestamp: ts(2) }),
    ]);
    runIndex(db);
    const threads = listThreads(db, { project: "repo" });
    expect(threads.length).toBe(1);
    expect(threads[0]!.id).toBe("ORIG");
    expect(threads[0]!.msgs).toBe(3);
    expect(threads[0]!.sessions_in_thread).toBe(2);
  });

  test("the threads view rolls up root + resume + subagent with root-preferring fields", () => {
    // Root: has a title and project_path. Resume: NULL title, different project_path,
    // and we delete its file so its body_available drops to 0. Subagent: folds into
    // the root's session id (does not add a sessions row).
    writeSession(env.projects, "-repo-root", "ROOT", [
      userMsg("ROOT", "u1", "start", {
        cwd: "/repo-root",
        timestamp: ts(0),
      }),
      assistantMsg("ROOT", "a1", "ok", {
        cwd: "/repo-root",
        parentUuid: "u1",
        timestamp: ts(1),
      }),
      // A summary line gives the root a title (priority 1).
      { type: "summary", summary: "Root title", leafUuid: "a1" },
    ]);
    const resumePath = writeSession(env.projects, "-repo-resume", "RESUME", [
      userMsg("RESUME", "u2", "more", {
        cwd: "/repo-resume",
        gitBranch: "resume-branch",
        parentUuid: "a1",
        timestamp: ts(2),
      }),
    ]);
    writeSubagent(env.projects, "-repo-root", "ROOT", "agent-1", [
      userMsg("ROOT", "su1", "subagent prompt", {
        cwd: "/repo-root",
        isSidechain: true,
        timestamp: ts(3),
      }),
      assistantMsg("ROOT", "sa1", "subagent reply", {
        cwd: "/repo-root",
        isSidechain: true,
        parentUuid: "su1",
        timestamp: ts(4),
      }),
    ]);
    runIndex(db);
    // Drop the resume's source file so a re-index marks its body unavailable.
    fs.rmSync(resumePath);
    runIndex(db);

    const thread = db
      .query(
        `SELECT id, last_ts, first_ts, msgs, sessions_in_thread, project_path, git_branch, title, body_available
         FROM threads WHERE id = ?`,
      )
      .get("ROOT") as {
      id: string;
      last_ts: string;
      first_ts: string;
      msgs: number;
      sessions_in_thread: number;
      project_path: string;
      git_branch: string | null;
      title: string | null;
      body_available: number;
    };

    expect(thread.id).toBe("ROOT");
    // Root-preferring: title, project_path, and git_branch come from the root, not
    // the resume.
    expect(thread.title).toBe("Root title");
    expect(thread.project_path).toBe("/repo-root");
    expect(thread.git_branch).toBe("main");
    // msgs is the sum across root (2) + resume (1) + folded subagent (2).
    expect(thread.msgs).toBe(5);
    // ROOT and RESUME are sessions rows; the subagent folds into ROOT.
    expect(thread.sessions_in_thread).toBe(2);
    // MIN: RESUME's body is unavailable (file deleted), so the thread is too.
    expect(thread.body_available).toBe(0);
    // Span covers the whole thread.
    expect(thread.first_ts).toBe(ts(0));
    expect(thread.last_ts).toBe(ts(4));
  });

  test("a session with no turns keeps its sessions row but is not a thread (#83)", () => {
    writeSession(env.projects, "-repo", "REAL", [
      userMsg("REAL", "u1", "real work", { timestamp: ts(0) }),
    ]);
    // A session opened and closed right away: a title event, no user/assistant turns.
    writeSession(env.projects, "-repo", "EMPTY", [
      { type: "summary", summary: "Title only, no turns", sessionId: "EMPTY" },
    ]);
    runIndex(db);

    // The sidecar row stays (it outlives Claude Code's own cleanup, so it is the only
    // record the session ever existed), with msg_count 0.
    expect(db.query("SELECT COUNT(*) AS c FROM sessions").get()).toEqual({ c: 2 });
    // But it is not a thread, and the listing and the count agree on that.
    expect(listThreads(db, {}).map((t) => t.id)).toEqual(["REAL"]);
    expect(countThreads(db)).toBe(1);
    expect(stats(db).threads).toBe(1);
    // Still reachable by id: show resolves it and renders an empty thread.
    expect(resolveSession(db, "EMPTY")).toBe("EMPTY");
    expect(threadMessages(db, "EMPTY")).toEqual([]);
  });

  test("zero-message threads stay out of recentThreads and the stats project rollup (#83)", () => {
    writeSession(env.projects, "-repo-x", "REAL", [
      userMsg("REAL", "u1", "real work", { cwd: "/repo-x", timestamp: ts(0) }),
    ]);
    runIndex(db);
    // A zero-message session that does carry a project_path (a title-only file has no
    // cwd to harvest one from, so it is written directly) would otherwise inflate both
    // the recent listing and the per-project thread counts.
    db.run(
      `INSERT INTO sessions (session_id, root_session_id, project_path, cwd, msg_count, first_ts, last_ts)
       VALUES ('EMPTY', 'EMPTY', '/repo-x', '/repo-x', 0, ?, ?)`,
      [ts(1), ts(1)],
    );

    const recent = recentThreads(db, { cwd: "/repo-x", since: ts(-100000), limit: 5 });
    expect(recent.map((t) => t.id)).toEqual(["REAL"]);
    expect(stats(db).topProjects).toEqual([{ project_path: "/repo-x", threads: 1 }]);
  });

  test("recentThreads scopes by project_path and respects the recency cutoff", () => {
    writeSession(env.projects, "-repo-x", "X", [
      userMsg("X", "ux", "work in x", { cwd: "/repo-x", timestamp: ts(0) }),
    ]);
    runIndex(db);

    const hit = recentThreads(db, { cwd: "/repo-x", since: ts(-100000), limit: 5 });
    expect(hit.map((t) => t.id)).toEqual(["X"]);

    const otherRepo = recentThreads(db, { cwd: "/repo-y", since: ts(-100000), limit: 5 });
    expect(otherRepo.length).toBe(0);

    const tooOld = recentThreads(db, { cwd: "/repo-x", since: ts(100000), limit: 5 });
    expect(tooOld.length).toBe(0);
  });

  test("every surface shows the same title, last activity and project for a resumed thread (#118)", () => {
    // The root ran once and never carried a title event; the resume carried the title
    // and ran a month later. Reading the root's own sessions row (as relevant and
    // digest search used to) showed the root's date and "(untitled)"; all four
    // surfaces must show the thread's rollup instead.
    const month = 30 * 86_400;
    writeSession(env.projects, "-repo", "ROOT", [
      userMsg("ROOT", "u1", "start the limiter work", { timestamp: ts(0) }),
      assistantMsg("ROOT", "a1", "ok", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    writeSession(env.projects, "-repo", "RESUME", [
      userMsg("RESUME", "u2", "continue the limiter work", {
        parentUuid: "a1",
        timestamp: ts(month),
      }),
      { type: "custom-title", customTitle: "Fixing the search ranking", sessionId: "RESUME" },
    ]);
    runIndex(db);
    writeSummary(db, "ROOT", "Worked on the limiter. Keywords: limiter");
    const now = Date.parse(ts(month));

    const surfaces = {
      sessions: listThreads(db)[0]!,
      recent: recentThreads(db, { cwd: "/repo", since: ts(-1), limit: 5 })[0]!,
      relevant: relevantThreads(db, "limiter", 3, now)[0]!,
      digestSearch: searchSummaries(db, "limiter")[0]!,
    };
    for (const [name, surface] of Object.entries(surfaces)) {
      expect({ name, ...surface }).toMatchObject({
        name,
        id: "ROOT",
        title: "Fixing the search ranking",
        last_ts: ts(month),
        project_path: "/repo",
      });
    }

    // The summary above made every relevant hit a tier-1 one. Drop it so the same
    // assertion runs through the raw tier, which shares the one hydration but would
    // not be covered by any assertion above if a future change split them again.
    db.run("DELETE FROM summaries");
    expect(relevantThreads(db, "limiter", 3, now)[0]!).toMatchObject({
      id: "ROOT",
      title: "Fixing the search ranking",
      last_ts: ts(month),
      project_path: "/repo",
      fromSummary: false,
    });
  });

  test("search hits show the thread's title and project, not the matched session's (#120)", () => {
    // The ordinary shape of a resumed thread: the root carries the cwd and never got a
    // title event, the resume carries the title and no cwd at all. Reading each hit's
    // own sessions row showed "(untitled)" for the root's hit and "(unknown)" for the
    // resume's, on a thread that has both.
    const month = 30 * 86_400;
    writeSession(env.projects, "-repo", "ROOT", [
      userMsg("ROOT", "u1", "start the limiter work", { timestamp: ts(0) }),
      assistantMsg("ROOT", "a1", "ok", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    writeSession(env.projects, "-repo", "RESUME", [
      userMsg("RESUME", "u2", "continue the limiter work", {
        parentUuid: "a1",
        cwd: undefined,
        timestamp: ts(month),
      }),
      { type: "custom-title", customTitle: "Fixing the search ranking", sessionId: "RESUME" },
    ]);
    runIndex(db);
    // The premise: the resume's own row really is missing the project.
    expect(
      (
        db.query("SELECT project_path FROM sessions WHERE session_id = 'RESUME'").get() as {
          project_path: string | null;
        }
      ).project_path,
    ).toBeNull();

    const thread = listThreads(db)[0]!;
    const hits = search(db, "limiter", 20, { all: true });
    expect(hits.map((h) => h.session_id).sort()).toEqual(["RESUME", "ROOT"]);
    for (const hit of hits) {
      // Whichever session the hit landed in, it agrees with the thread listing.
      expect({ id: hit.session_id, title: hit.title, project_path: hit.project_path }).toEqual({
        id: hit.session_id,
        title: thread.title,
        project_path: thread.project_path,
      });
    }

    // The sharp edge: a hit that matched --project must never render (unknown).
    const scoped = search(db, "limiter", 20, { all: true, project: "repo" });
    expect(scoped.map((h) => h.session_id).sort()).toEqual(["RESUME", "ROOT"]);
    expect(scoped.every((h) => h.project_path === "/repo")).toBe(true);

    // Per-message fields are untouched: ts stays the matched turn's, not the thread's.
    const resumeHit = hits.find((h) => h.session_id === "RESUME")!;
    expect(resumeHit.ts).toBe(ts(month));
    expect(resumeHit.git_branch).toBe("main");
    expect(resumeHit.ordinal).toBe(3);
  });

  test("a search hit whose thread is absent from the rollup falls back to its own row (#120)", () => {
    // The `threads` view drops a thread whose sessions sum to zero messages, so a row
    // with a stale msg_count is one way the hydration comes back empty. Contrived, but
    // it pins the fallback: the hit renders on its own session row instead of losing
    // its title and project (or being dropped) because the rollup had nothing to say.
    writeSession(env.projects, "-repo", "STALE", [
      userMsg("STALE", "u1", "the limiter work", { timestamp: ts(0) }),
      { type: "custom-title", customTitle: "Rate limiting", sessionId: "STALE" },
    ]);
    runIndex(db);
    db.run("UPDATE sessions SET msg_count = 0 WHERE session_id = 'STALE'");
    expect(listThreads(db).length).toBe(0);

    const hits = search(db, "limiter", 20, { all: true });
    expect(hits.length).toBe(1);
    expect(hits[0]).toMatchObject({
      session_id: "STALE",
      title: "Rate limiting",
      project_path: "/repo",
    });
  });

  test("resolveSession handles exact id, unique prefix, miss, and ambiguity", () => {
    writeSession(env.projects, "-repo", "abc12345-aaaa", [userMsg("abc12345-aaaa", "u1", "a")]);
    writeSession(env.projects, "-repo", "abc99999-bbbb", [userMsg("abc99999-bbbb", "u2", "b")]);
    runIndex(db);

    expect(resolveSession(db, "abc12345-aaaa")).toBe("abc12345-aaaa");
    expect(resolveSession(db, "abc12345")).toBe("abc12345-aaaa"); // unique prefix
    expect(resolveSession(db, "zzz")).toBeNull(); // no match
    expect(() => resolveSession(db, "abc")).toThrow(/[Aa]mbiguous/); // matches both
  });

  test("resolveSession treats LIKE wildcards in a prefix literally (#48)", () => {
    writeSession(env.projects, "-repo", "abc12345-aaaa", [userMsg("abc12345-aaaa", "u1", "a")]);
    runIndex(db);
    // `_` would match any character unescaped; `%` would match everything.
    expect(resolveSession(db, "abc_2345")).toBeNull();
    expect(resolveSession(db, "%")).toBeNull();
  });

  test("--project filter treats LIKE wildcards literally (#48)", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "hi", { cwd: "/home/user/myXapp" }),
    ]);
    runIndex(db);
    // Unescaped, `my_app` would match `myXapp` via the `_` wildcard.
    expect(listThreads(db, { project: "my_app" }).length).toBe(0);
    expect(listThreads(db, { project: "myXapp" }).length).toBe(1);
  });

  test("--branch filter treats LIKE wildcards literally (#48)", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "branchy work", { gitBranch: "feature/myXapp" }),
    ]);
    runIndex(db);
    expect(listThreads(db, { branch: "my_app" }).length).toBe(0);
    expect(listThreads(db, { branch: "myXapp" }).length).toBe(1);
    expect(search(db, "branchy", 10, { branch: "my_app" }).length).toBe(0);
    expect(search(db, "branchy", 10, { branch: "myXapp" }).length).toBe(1);
  });

  test("stats excludes subagent-only stubs from deleted sources (#45)", () => {
    // A parent stub created purely from a subagent file: source_file is NULL,
    // body_available becomes 0, but nothing was ever deleted.
    writeSubagent(env.projects, "-repo", "STUB", "agent-1", [
      userMsg("STUB", "sa1", "sub work", { isSidechain: true }),
    ]);
    const path = writeSession(env.projects, "-repo", "REAL", [userMsg("REAL", "u1", "hi")]);
    runIndex(db);
    expect(stats(db).deletedSources).toBe(0);
    // A genuinely deleted source still counts.
    fs.rmSync(path);
    runIndex(db);
    expect(stats(db).deletedSources).toBe(1);
  });

  test("stats counts threads, sessions, messages, and deleted sources", () => {
    writeSession(env.projects, "-repo", "ORIG", [
      userMsg("ORIG", "u1", "start", { timestamp: ts(0) }),
      assistantMsg("ORIG", "a1", "ok", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    writeSession(env.projects, "-repo", "RESUME", [
      userMsg("RESUME", "u2", "more", { parentUuid: "a1", timestamp: ts(2) }),
    ]);
    // A second, independent thread so the thread count is exercised above one.
    writeSession(env.projects, "-repo", "OTHER", [
      userMsg("OTHER", "u3", "another", { timestamp: ts(3) }),
    ]);
    runIndex(db);
    const s = stats(db);
    expect(s.sessions).toBe(3);
    expect(s.threads).toBe(2); // RESUME folds into ORIG; OTHER is its own thread
    expect(s.messages).toBe(4);
    expect(s.deletedSources).toBe(0);
  });
});
