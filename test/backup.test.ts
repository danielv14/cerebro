import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBackup } from "../src/backup.ts";
import { openDb } from "../src/db.ts";

describe("runBackup", () => {
  let dir: string;
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "cerebro-backup-test-"));
    dbPath = join(dir, "archive.sqlite");
    db = openDb(dbPath);
    db.run("INSERT INTO messages (uuid, session_id, text) VALUES ('u1', 'S', 'precious')");
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("writes a timestamped snapshot to the default backups dir", () => {
    const result = runBackup(db, dbPath, {}, new Date("2026-07-02T10:15:30Z"));
    expect(result.path).toBe(join(dir, "backups", "archive-20260702-101530.sqlite"));
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.pruned).toEqual([]);
    // The snapshot is a complete, standalone database.
    const copy = new Database(result.path, { readonly: true });
    expect(copy.query("SELECT text FROM messages WHERE uuid='u1'").get()).toEqual({
      text: "precious",
    });
    copy.close();
  });

  test("honors an explicit --to target and refuses to overwrite", () => {
    const to = join(dir, "elsewhere", "snap.sqlite");
    const result = runBackup(db, dbPath, { to });
    expect(result.path).toBe(to);
    expect(fs.existsSync(to)).toBe(true);
    expect(() => runBackup(db, dbPath, { to })).toThrow(/already exists/);
  });

  test("--keep prunes the oldest default-named backups only", () => {
    runBackup(db, dbPath, {}, new Date("2026-07-01T00:00:00Z"));
    runBackup(db, dbPath, {}, new Date("2026-07-02T00:00:00Z"));
    // An unrelated file in the backups dir must never be pruned.
    const stray = join(dir, "backups", "notes.txt");
    fs.writeFileSync(stray, "keep me");
    const result = runBackup(db, dbPath, { keep: 2 }, new Date("2026-07-03T00:00:00Z"));
    expect(result.pruned).toEqual([join(dir, "backups", "archive-20260701-000000.sqlite")]);
    const remaining = fs.readdirSync(join(dir, "backups")).sort();
    expect(remaining).toEqual([
      "archive-20260702-000000.sqlite",
      "archive-20260703-000000.sqlite",
      "notes.txt",
    ]);
  });

  test("refuses an in-memory database", () => {
    const mem = new Database(":memory:");
    expect(() => runBackup(mem, ":memory:", {})).toThrow(/in-memory/);
    mem.close();
  });
});
