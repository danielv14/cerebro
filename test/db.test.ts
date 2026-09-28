import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, SCHEMA_VERSION } from "../src/db.ts";
import { threadsViewIsCurrent } from "../src/thread.ts";

describe("openDb schema versioning", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "cerebro-db-test-"));
    path = join(dir, "archive.sqlite");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a fresh database is created, usable, and stamped", () => {
    const db = openDb(path);
    const version = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(SCHEMA_VERSION);
    expect(db.query("SELECT COUNT(*) AS c FROM sessions").get()).toEqual({ c: 0 });
    expect(db.query("SELECT COUNT(*) AS c FROM messages").get()).toEqual({ c: 0 });
    db.close();
  });

  test("reopening an up-to-date database works and keeps the stamp", () => {
    openDb(path).close();
    const db = openDb(path);
    const version = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(SCHEMA_VERSION);
    db.run("INSERT INTO messages (uuid, session_id) VALUES ('u1', 'S')");
    expect(db.query("SELECT COUNT(*) AS c FROM messages").get()).toEqual({ c: 1 });
    db.close();
  });

  test("an old-version database re-runs DDL and migrations on open", () => {
    const db = openDb(path);
    db.run("ALTER TABLE sessions DROP COLUMN title_priority");
    db.run("PRAGMA user_version = 0");
    db.close();

    const reopened = openDb(path);
    const cols = reopened.query("PRAGMA table_info(sessions)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "title_priority")).toBe(true);
    const version = reopened.query("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(SCHEMA_VERSION);
    reopened.close();
  });

  test("a database stamped by a newer build is opened as-is, never stamped down (#199)", () => {
    const db = openDb(path);
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.run("CREATE TABLE from_the_future (x INTEGER)");
    db.close();

    const reopened = openDb(path);
    const version = reopened.query("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(SCHEMA_VERSION + 1);
    expect(reopened.query("SELECT COUNT(*) AS c FROM from_the_future").get()).toEqual({ c: 0 });
    expect(reopened.query("SELECT COUNT(*) AS c FROM threads").get()).toEqual({ c: 0 });
    reopened.close();
  });

  test("migration backfills provider='claude-code' on pre-adapter rows", () => {
    // Model stays NULL, it cannot be recovered.
    const db = openDb(path);
    db.run("INSERT INTO sessions (session_id, msg_count) VALUES ('OLD', 3)");
    // The threads view references both columns, and SQLite refuses to drop a
    // column the schema still mentions; reopening recreates the view anyway.
    db.run("DROP VIEW threads");
    db.run("ALTER TABLE sessions DROP COLUMN provider");
    db.run("ALTER TABLE sessions DROP COLUMN model");
    db.run("PRAGMA user_version = 0");
    db.close();

    const reopened = openDb(path);
    const row = reopened
      .query("SELECT provider, model FROM sessions WHERE session_id = 'OLD'")
      .get() as { provider: string; model: string | null };
    expect(row).toEqual({ provider: "claude-code", model: null });
    reopened.close();
  });

  test("an old-version database gets the current threads view definition (#83)", () => {
    const db = openDb(path);
    db.run("DROP VIEW threads");
    db.run(
      `CREATE VIEW threads AS
         SELECT r.root_session_id AS id, MAX(r.last_ts) AS last_ts, MIN(r.first_ts) AS first_ts,
                SUM(r.msg_count) AS msgs, COUNT(*) AS sessions_in_thread,
                MAX(r.project_path) AS project_path, MAX(r.git_root) AS git_root,
                MAX(r.title) AS title, MIN(r.body_available) AS body_available
         FROM sessions r
         GROUP BY r.root_session_id`,
    );
    db.run("INSERT INTO sessions (session_id, root_session_id, msg_count) VALUES ('E', 'E', 0)");
    expect(db.query("SELECT COUNT(*) AS c FROM threads").get()).toEqual({ c: 1 });
    db.run("PRAGMA user_version = 0");
    db.close();

    const reopened = openDb(path);
    expect(reopened.query("SELECT COUNT(*) AS c FROM threads").get()).toEqual({ c: 0 });
    expect(reopened.query("SELECT COUNT(*) AS c FROM sessions").get()).toEqual({ c: 1 });
    reopened.close();
  });

  test("a wrong-shaped threads view is replaced even when the stamp is current", () => {
    const db = openDb(path);
    db.run("DROP VIEW threads");
    db.run(
      `CREATE VIEW threads AS
         SELECT r.root_session_id AS id, MAX(r.last_ts) AS last_ts, MIN(r.first_ts) AS first_ts,
                SUM(r.msg_count) AS msgs, COUNT(*) AS sessions_in_thread,
                MAX(r.project_path) AS project_path, MAX(r.git_root) AS git_root,
                MAX(r.title) AS title, MIN(r.body_available) AS body_available
         FROM sessions r
         GROUP BY r.root_session_id
         HAVING SUM(r.msg_count) > 0`,
    );
    db.close();

    const reopened = openDb(path);
    const cols = reopened.query("PRAGMA table_info(threads)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "git_branch")).toBe(true);
    const version = reopened.query("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(SCHEMA_VERSION);
    reopened.close();
  });

  test("the shape check agrees with the view the DDL creates", () => {
    const db = openDb(path);
    expect(threadsViewIsCurrent(db)).toBe(true);
    db.close();
  });

  test("messages keeps the legacy line_no column for the deployed hook binary", () => {
    const db = openDb(path);
    const cols = db.query("PRAGMA table_info(messages)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "line_no")).toBe(true);
    db.run(
      `INSERT OR IGNORE INTO messages (uuid, session_id, parent_uuid, line_no, ts, role, text, is_sidechain)
       VALUES ('u1', 'S', NULL, NULL, NULL, 'user', 'x', 0)`,
    );
    expect(db.query("SELECT COUNT(*) AS c FROM messages").get()).toEqual({ c: 1 });
    db.close();
  });

  test("per-connection pragmas apply on every open", () => {
    openDb(path).close();
    const db = openDb(path);
    const busy = db.query("PRAGMA busy_timeout").get() as { timeout: number };
    expect(busy.timeout).toBe(5000);
    db.close();
  });
});
