import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";
import { doctorReport } from "../../src/commands/doctor.ts";
import { statsCommand } from "../../src/commands/stats.ts";
import { openDb, SCHEMA_VERSION } from "../../src/db.ts";
import { writeSummary } from "../../src/digest/index.ts";
import { type Check, type DoctorReport, deployedBinaryPath, runDoctor } from "../../src/doctor.ts";
import { runIndex } from "../../src/indexer.ts";
import { rootOf } from "../../src/thread.ts";
import {
  assistantMsg,
  makeClaudeDir,
  type TempClaude,
  ts,
  userMsg,
  writeSession,
} from "../fixtures.ts";

const byKey = (report: DoctorReport, key: string): Check => {
  const check = report.checks.find((c) => c.key === key);
  if (!check) throw new Error(`no check with key ${key}`);
  return check;
};

describe("runDoctor", () => {
  let env: TempClaude;
  let db: Database;
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    env = makeClaudeDir();
    process.env.CEREBRO_CLAUDE_DIR = env.claudeRoot;
    // Point the deployed-binary lookup at the fixture too, so a real binary in the
    // developer's ~/.claude cannot make these assertions flap.
    process.env.CLAUDE_CONFIG_DIR = env.claudeRoot;
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
    env.cleanup();
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  });

  test("a healthy archive passes every hard check", () => {
    writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "hello")]);
    runIndex(db);
    const report = runDoctor(db, ":memory:");
    expect(report.ok).toBe(true);
    expect(report.checks.some((c) => c.status === "fail")).toBe(false);
    expect(byKey(report, "schema")).toMatchObject({
      status: "ok",
      detail: `v${SCHEMA_VERSION} (current)`,
    });
    expect(byKey(report, "integrity").status).toBe("ok");
    expect(byKey(report, "fts:messages_fts").status).toBe("ok");
    expect(byKey(report, "fts:summaries_fts").status).toBe("ok");
  });

  test("every check reports under its own key exactly once (#124)", () => {
    // The failure the builder rules out: a check whose branches disagree on their own
    // key, handing --json consumers two entries for one check.
    writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "hello")]);
    runIndex(db);
    const keys = runDoctor(db, ":memory:").checks.map((c) => c.key);
    expect(keys.length).toBe(new Set(keys).size);
    expect(keys.every((key) => key.length > 0)).toBe(true);
  });

  test("--full runs the complete integrity_check instead of quick_check", () => {
    writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "hello")]);
    runIndex(db);
    expect(byKey(runDoctor(db, ":memory:"), "integrity").detail).toBe("quick_check");
    expect(byKey(runDoctor(db, ":memory:", { full: true }), "integrity").detail).toBe(
      "integrity_check",
    );
  });

  test("a schema from another build is a hard failure, not a warning", () => {
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    const report = runDoctor(db, ":memory:");
    expect(byKey(report, "schema").status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  test("orphaned index_state rows are reported with the command that prunes them", () => {
    writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "hello")]);
    runIndex(db);
    db.run("INSERT INTO index_state (source_file) VALUES ('/gone/nowhere.jsonl')");
    const check = byKey(runDoctor(db, ":memory:"), "cursors");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("1 of 2");
    expect(check.remedy).toBe("cerebro index");
    // A warning is not a failure: doctor stays usable as a cron guard.
    expect(runDoctor(db, ":memory:").ok).toBe(true);
  });

  test("the doctor count and the prune target agree on the same fixture set (#137)", () => {
    // Two indexed files, one deleted afterwards. Doctor counts orphans through the
    // same reader the prune deletes through, so what it reports must be exactly
    // what the next `cerebro index` removes.
    const goneAfter = writeSession(env.projects, "-repo", "GONE", [userMsg("GONE", "g1", "bye")]);
    writeSession(env.projects, "-repo", "KEPT", [userMsg("KEPT", "k1", "hi")]);
    runIndex(db);
    fs.rmSync(goneAfter);

    const check = byKey(runDoctor(db, ":memory:"), "cursors");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("1 of 2");

    runIndex(db); // the prune removes what doctor counted, nothing else
    const remaining = db.query("SELECT source_file FROM index_state").all() as {
      source_file: string;
    }[];
    expect(remaining.map((r) => r.source_file)).not.toContain(goneAfter);
    expect(remaining).toHaveLength(1);
    expect(byKey(runDoctor(db, ":memory:"), "cursors").detail).toBe("1 rows, no orphans");
  });

  test("zero-message sessions are reported without being treated as a problem", () => {
    writeSession(env.projects, "-repo", "REAL", [userMsg("REAL", "u1", "hello")]);
    writeSession(env.projects, "-repo", "EMPTY", [
      { type: "custom-title", customTitle: "Title only", sessionId: "EMPTY" },
    ]);
    runIndex(db);
    const check = byKey(runDoctor(db, ":memory:"), "empty-sessions");
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("1");
    expect(check.detail).toContain("rows kept on purpose");
  });

  test("a missing deployed binary is an unknown, not a throw", () => {
    expect(fs.existsSync(deployedBinaryPath())).toBe(false);
    const check = byKey(runDoctor(db, ":memory:"), "deployed");
    expect(check.status).toBe("unknown");
    expect(check.remedy).toBe("bun run deploy");
  });

  test("a missing settings.json degrades the hook check to unknown", () => {
    expect(byKey(runDoctor(db, ":memory:"), "hook:SessionEnd").status).toBe("unknown");
  });

  test("an unparseable settings.json degrades instead of throwing", () => {
    fs.writeFileSync(join(env.claudeRoot, "settings.json"), "{ not json");
    const check = byKey(runDoctor(db, ":memory:"), "hook:SessionEnd");
    expect(check.status).toBe("unknown");
    expect(check.detail).toContain("not valid JSON");
  });

  test("hook wiring is detected from settings.json and reported, never edited", () => {
    const path = join(env.claudeRoot, "settings.json");
    const settings = {
      hooks: {
        SessionEnd: [{ matcher: "clear", hooks: [{ type: "command", command: "cerebro index" }] }],
      },
    };
    fs.writeFileSync(path, JSON.stringify(settings));
    expect(byKey(runDoctor(db, ":memory:"), "hook:SessionEnd").status).toBe("ok");
    // Read-only: the file is byte-identical afterwards.
    expect(fs.readFileSync(path, "utf8")).toBe(JSON.stringify(settings));
  });

  test("a SessionEnd hook wired to something other than cerebro warns", () => {
    fs.writeFileSync(
      join(env.claudeRoot, "settings.json"),
      JSON.stringify({
        hooks: {
          SessionEnd: [{ matcher: "clear", hooks: [{ type: "command", command: "/bin/true" }] }],
        },
      }),
    );
    expect(byKey(runDoctor(db, ":memory:"), "hook:SessionEnd").status).toBe("warn");
  });

  test("digest coverage warns while a backlog exists and passes once it is drained", () => {
    writeSession(env.projects, "-repo", "S", [userMsg("S", "u1", "hello")]);
    runIndex(db);
    const stale = byKey(runDoctor(db, ":memory:"), "digest");
    expect(stale.status).toBe("warn");
    expect(stale.detail).toBe("0/1 threads summarized, 1 stale");
  });

  test("stats and doctor agree once a relink moves a summarized root (#121)", () => {
    // RESUME is indexed and summarized while it is its own thread root, then the
    // original transcript arrives and relinkThreads reroots it under ORIG. The
    // summary is left keyed on an id no thread is rooted at, which is where the two
    // commands used to disagree: stats counted every `summaries` row, doctor counted
    // only the ones joining the threads view.
    writeSession(env.projects, "-repo", "RESUME", [
      userMsg("RESUME", "u2", "carry on", { parentUuid: "a1", timestamp: ts(2) }),
    ]);
    runIndex(db);
    writeSummary(db, "RESUME", "Summary written before the original showed up.");

    writeSession(env.projects, "-repo", "ORIG", [
      userMsg("ORIG", "u1", "start", { timestamp: ts(0) }),
      assistantMsg("ORIG", "a1", "ok", { parentUuid: "u1", timestamp: ts(1) }),
    ]);
    runIndex(db);
    expect(rootOf(db, "RESUME")).toBe("ORIG");

    const threadsLine = statsCommand
      .run({
        db,
        args: { json: false },
        rest: [],
        dbPath: ":memory:",
        now: Date.parse(ts(0)),
        cwd: "/repo",
        progress: () => {},
      })
      .lines!.find((line) => line.startsWith("Threads:"));
    expect(threadsLine).toBe("Threads:          1 (0 summarized, 1 stale)");
    expect(byKey(runDoctor(db, ":memory:"), "digest").detail).toBe(
      "0/1 threads summarized, 1 stale",
    );
  });
});

describe("doctorReport", () => {
  const report: DoctorReport = {
    build: {
      version: "0.1.0",
      commit: "a1b2c3d",
      builtAt: "2026-07-26T09:12:00Z",
      bun: "1.3.14",
      stamped: true,
    },
    checks: [
      { key: "schema", group: "Database", label: "schema", status: "ok", detail: "v4 (current)" },
      {
        key: "wal",
        group: "Database",
        label: "wal",
        status: "warn",
        detail: "90000000 bytes",
        remedy: "cerebro maintain",
      },
    ],
    ok: true,
  };

  test("renders the build line, grouped checks, remedies and the verdict", () => {
    expect(doctorReport(report, "/tmp/archive.sqlite", 5 * 1024 * 1024)).toEqual([
      "running    cerebro 0.1.0 (a1b2c3d, built 2026-07-26T09:12:00Z, bun 1.3.14)",
      "database   /tmp/archive.sqlite (5.0 MB)",
      "",
      "Database",
      "  ok    schema            v4 (current)",
      "  warn  wal               90000000 bytes  -> cerebro maintain",
      "",
      "All checks passed, 1 warning(s).",
    ]);
  });

  test("a failure is marked and counted in the verdict", () => {
    const failing: DoctorReport = {
      ...report,
      checks: [{ ...report.checks[0]!, status: "fail", detail: "v3, this build expects v4" }],
      ok: false,
    };
    const lines = doctorReport(failing, "/tmp/archive.sqlite", null);
    expect(lines).toContain("  FAIL  schema            v3, this build expects v4");
    expect(lines.at(-1)).toBe("1 check(s) FAILED, 0 warning(s).");
    // No size suffix when the file cannot be measured.
    expect(lines[1]).toBe("database   /tmp/archive.sqlite");
  });
});
