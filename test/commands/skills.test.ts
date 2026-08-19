import { describe, expect, test } from "bun:test";
import { skillsListing } from "../../src/commands/skills.ts";

describe("skillsListing", () => {
  const usage = {
    rows: [
      {
        name: "commit",
        slash: 60,
        model: 86,
        total: 146,
        sidechain: 0,
        lastTs: "2026-08-18T09:00:00Z",
      },
      {
        name: "changelog",
        slash: 8,
        model: 39,
        total: 47,
        sidechain: 2,
        lastTs: "2026-08-01T09:00:00Z",
      },
    ],
    distinct: 2,
    from: "2026-05-11T08:00:00Z",
    to: "2026-08-19T08:00:00Z",
  };

  test("renders the window, the column header, and one aligned row per name", () => {
    expect(skillsListing(usage)).toEqual([
      "2 names, 2026-05-11 .. 2026-08-19 (built-in commands included; sub is the subagent part of total)",
      "name                                slash  model  total    sub  last",
      "commit                                 60     86    146      0  2026-08-18",
      "changelog                               8     39     47      2  2026-08-01",
    ]);
  });

  test("truncates a name to its column so the counts stay aligned", () => {
    const long = {
      ...usage,
      rows: [{ ...usage.rows[0]!, name: "a-plugin:a-very-long-skill-name-that-runs-on" }],
      distinct: 1,
    };
    const [, , row] = skillsListing(long);
    expect(row).toBe("a-plugin:a-very-long-skill-name-t…     60     86    146      0  2026-08-18");
  });

  test("says name in the singular when only one was seen", () => {
    const one = { ...usage, rows: usage.rows.slice(0, 1), distinct: 1 };
    expect(skillsListing(one)[0]).toStartWith("1 name,");
  });

  test("says the list was trimmed when a limit dropped names", () => {
    const trimmed = { ...usage, rows: usage.rows.slice(0, 1), distinct: 12 };
    expect(skillsListing(trimmed)[0]).toContain("top 1 of 12 names");
  });
});
