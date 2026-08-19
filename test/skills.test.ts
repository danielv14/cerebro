import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db.ts";
import { runIndex } from "../src/indexer.ts";
import { skillUsage } from "../src/skills.ts";
import {
  assistantMsg,
  makeClaudeDir,
  type TempClaude,
  ts,
  userMsg,
  writeSession,
  writeSubagent,
} from "./fixtures.ts";

// A typed `/name` as Claude Code expands it into the user turn.
const slashCall = (name: string): string =>
  `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args></command-args>`;

// A Skill tool_use block as the model emits it; `args` is optional, exactly as in
// the real log.
const skillTool = (name: string, args?: string): unknown[] => [
  {
    type: "tool_use",
    name: "Skill",
    input: args === undefined ? { skill: name } : { skill: name, args },
  },
];

// The tool_result side of a Skill call. Recorded as a `user` turn.
const skillResult = (name: string): unknown[] => [
  { type: "tool_result", content: `Launching skill: ${name}` },
];

describe("skillUsage", () => {
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

  const byName = (name: string) => {
    const usage = skillUsage(db);
    return usage.rows.find((row) => row.name === name);
  };

  test("counts both markers: the slash expansion and the model's Skill call", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", slashCall("commit"), { timestamp: ts(0) }),
      assistantMsg("S", "a1", skillTool("commit"), { parentUuid: "u1", timestamp: ts(1) }),
      assistantMsg("S", "a2", skillTool("commit"), { parentUuid: "a1", timestamp: ts(2) }),
    ]);
    runIndex(db);
    expect(byName("commit")).toEqual({
      name: "commit",
      slash: 1,
      model: 2,
      total: 3,
      sidechain: 0,
      lastTs: ts(2),
    });
  });

  test("`Launching skill:` is the same call, not a third marker", () => {
    writeSession(env.projects, "-repo", "S", [
      assistantMsg("S", "a1", skillTool("deep-review"), { timestamp: ts(0) }),
      userMsg("S", "u1", skillResult("deep-review"), { parentUuid: "a1", timestamp: ts(1) }),
    ]);
    runIndex(db);
    expect(byName("deep-review")?.total).toBe(1);
  });

  test("a quoted marker on the other side of the conversation does not count", () => {
    // A transcript that greps for the markers, or prints these very numbers, lands
    // in a tool_result on the user side. Without the role filter the measurement
    // counts itself every time it runs.
    writeSession(env.projects, "-repo", "S", [
      userMsg(
        "S",
        "u1",
        [{ type: "tool_result", content: '[tool_use:Skill] {"skill":"standup"}' }],
        {
          timestamp: ts(0),
        },
      ),
      assistantMsg("S", "a1", `I found <command-name>/standup</command-name> in the log`, {
        parentUuid: "u1",
        timestamp: ts(1),
      }),
    ]);
    runIndex(db);
    expect(byName("standup")).toBeUndefined();
  });

  test("a marker quoted mid-sentence by the assistant is prose, not a call", () => {
    // Documenting the format is not using the skill. The real rendering always opens
    // a line, so an inline mention is distinguishable.
    writeSession(env.projects, "-repo", "S", [
      assistantMsg("S", "a1", 'match on [tool_use:Skill] {"skill":"X"} without the brace', {
        timestamp: ts(0),
      }),
    ]);
    runIndex(db);
    expect(byName("X")).toBeUndefined();
  });

  test("a marker quoted inside cerebro's own output does not count", () => {
    // `show` and `recent` collapse a turn onto one line, so a recall of a session that
    // used a skill puts the marker mid-line inside a tool_result. Counting it would
    // make every recall inflate the numbers it just reported.
    writeSession(env.projects, "-repo", "S", [
      userMsg(
        "S",
        "u1",
        [
          {
            type: "tool_result",
            content: `1. user  2026-06-18 22:41  ${slashCall("standup")}`,
          },
        ],
        { timestamp: ts(0) },
      ),
    ]);
    runIndex(db);
    expect(byName("standup")).toBeUndefined();
  });

  test("an unclosed marker does not swallow the next real call", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", `<command-name> oops\n${slashCall("commit")}`, { timestamp: ts(0) }),
    ]);
    runIndex(db);
    expect(byName("commit")?.slash).toBe(1);
    expect(skillUsage(db).rows.length).toBe(1);
  });

  test("text that cannot be a name is not reported as one", () => {
    // The slice between two markers is foreign input: an opening tag whose nearest
    // closing tag is far away would otherwise print an arbitrary chunk of someone's
    // transcript as a skill name.
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", "<command-name>a name\nwith a newline and a secret</command-name>", {
        timestamp: ts(0),
      }),
    ]);
    runIndex(db);
    expect(skillUsage(db).rows).toEqual([]);
  });

  test("a call with arguments counts (the payload is prefix-matched, not parsed)", () => {
    writeSession(env.projects, "-repo", "S", [
      assistantMsg("S", "a1", skillTool("changelog", "the last two weeks"), {
        timestamp: ts(0),
      }),
    ]);
    runIndex(db);
    expect(byName("changelog")?.model).toBe(1);
  });

  test("counts occurrences, not messages", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", `${slashCall("commit")}\n${slashCall("commit")}`, { timestamp: ts(0) }),
      assistantMsg("S", "a1", [...skillTool("commit"), ...skillTool("cerebro")], {
        parentUuid: "u1",
        timestamp: ts(1),
      }),
    ]);
    runIndex(db);
    expect(byName("commit")).toMatchObject({ slash: 2, model: 1, total: 3 });
    expect(byName("cerebro")?.model).toBe(1);
  });

  test("a subagent's call counts, and is reported separately", () => {
    writeSession(env.projects, "-repo", "P", [
      userMsg("P", "u1", "run the review", { timestamp: ts(0) }),
      assistantMsg("P", "a1", skillTool("code-review"), { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    writeSubagent(env.projects, "-repo", "P", "agent-1", [
      assistantMsg("P", "s1", skillTool("code-review"), { timestamp: ts(2), isSidechain: true }),
    ]);
    runIndex(db);
    expect(byName("code-review")).toMatchObject({ model: 2, total: 2, sidechain: 1 });
  });

  test("reports every name it saw, plugin-qualified ones included", () => {
    writeSession(env.projects, "-repo", "S", [
      assistantMsg("S", "a1", skillTool("code-review:code-review"), { timestamp: ts(0) }),
      userMsg("S", "u1", slashCall("clear"), { parentUuid: "a1", timestamp: ts(1) }),
    ]);
    runIndex(db);
    expect(
      skillUsage(db)
        .rows.map((row) => row.name)
        .sort(),
    ).toEqual(["clear", "code-review:code-review"]);
  });

  test("orders by total descending, then by name", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", `${slashCall("bbb")}\n${slashCall("bbb")}`, { timestamp: ts(0) }),
      userMsg("S", "u2", slashCall("aaa"), { parentUuid: "u1", timestamp: ts(1) }),
      userMsg("S", "u3", slashCall("ccc"), { parentUuid: "u2", timestamp: ts(2) }),
    ]);
    runIndex(db);
    expect(skillUsage(db).rows.map((row) => row.name)).toEqual(["bbb", "aaa", "ccc"]);
  });

  test("--limit trims the listing but distinct still reports what was seen", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", `${slashCall("aaa")}\n${slashCall("bbb")}`, { timestamp: ts(0) }),
    ]);
    runIndex(db);
    const usage = skillUsage(db, { limit: 1 });
    expect(usage.rows.length).toBe(1);
    expect(usage.distinct).toBe(2);
  });

  test("--since excludes earlier calls and becomes the reported window start", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", slashCall("standup"), { timestamp: "2026-01-01T10:00:00.000Z" }),
      userMsg("S", "u2", slashCall("standup"), {
        parentUuid: "u1",
        timestamp: "2026-03-01T10:00:00.000Z",
      }),
    ]);
    runIndex(db);
    const usage = skillUsage(db, { since: "2026-02-01" });
    expect(usage.rows[0]).toMatchObject({ name: "standup", slash: 1 });
    expect(usage.from).toBe("2026-02-01");
  });

  test("reports the archive span when no cutoff was given", () => {
    writeSession(env.projects, "-repo", "S", [
      userMsg("S", "u1", slashCall("standup"), { timestamp: ts(0) }),
      assistantMsg("S", "a1", "done", { parentUuid: "u1", timestamp: ts(5) }),
    ]);
    runIndex(db);
    const usage = skillUsage(db);
    expect(usage.from).toBe(ts(0));
    expect(usage.to).toBe(ts(5));
  });

  test("an archive with no skill calls yields no rows", () => {
    writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "just a prompt")]);
    runIndex(db);
    expect(skillUsage(db).rows).toEqual([]);
    expect(skillUsage(db).distinct).toBe(0);
  });
});
