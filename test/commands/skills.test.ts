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
    scanned: 120,
  };

  test("renders the window, the column header, and one aligned row per skill", () => {
    expect(skillsListing(usage)).toEqual([
      "2 skills, 2026-05-11 .. 2026-08-19 (sub = the part of total from subagent turns)",
      "name                                slash  model    sub  total  last",
      "commit                                 60     86      0    146  2026-08-18",
      "changelog                               8     39      2     47  2026-08-01",
    ]);
  });

  test("says the list was trimmed when a limit dropped names", () => {
    const trimmed = { ...usage, rows: usage.rows.slice(0, 1), distinct: 12 };
    expect(skillsListing(trimmed)[0]).toContain("top 1 of 12 skills");
  });
});
