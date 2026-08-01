import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, SCHEMA_VERSION } from "../src/db.ts";

// The version-gated schema (#46): the DDL runs once per SCHEMA_VERSION and the
// stamp lets every later open (the per-prompt hook hot path) skip it entirely.
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
    // The schema is in place: core tables answer queries.
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
    // Simulate a database from before a migration: strip a migrated column and
    // reset the stamp. Reopening must re-add the column and re-stamp.
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

  test("an old-version database gets the current threads view definition (#83)", () => {
    // CREATE VIEW IF NOT EXISTS does not replace an existing view, so the DDL drops
    // the view first. Without that, an old database would keep serving its stale
    // rollup (here: a pre-#83 one with no HAVING) forever. Simulate one, reset the
    // stamp, and reopen.
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
    // The old definition rolls the zero-message session up into a thread.
    expect(db.query("SELECT COUNT(*) AS c FROM threads").get()).toEqual({ c: 1 });
    db.run("PRAGMA user_version = 0");
    db.close();

    const reopened = openDb(path);
    // The replaced view excludes it, and the session row itself is untouched.
    expect(reopened.query("SELECT COUNT(*) AS c FROM threads").get()).toEqual({ c: 0 });
    expect(reopened.query("SELECT COUNT(*) AS c FROM sessions").get()).toEqual({ c: 1 });
    reopened.close();
  });

  test("a wrong-shaped threads view is replaced even when the stamp is current", () => {
    // A binary built for a different SCHEMA_VERSION racing this one through the
    // first open after an upgrade can leave the current stamp over its own (older)
    // view. Version-gating alone would trust that forever and every reader of the
    // missing column would fail; the open-time shape check must heal it. Simulate
    // the wedged state: current stamp, pre-v5 view (no git_branch).
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

  test("messages keeps the legacy line_no column for the deployed hook binary", () => {
    // The compiled hook binary is a frozen snapshot whose INSERT names line_no;
    // dropping (or omitting) the column would make every automated index run fail
    // silently until the next deploy. It must exist on fresh databases too.
    const db = openDb(path);
    const cols = db.query("PRAGMA table_info(messages)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "line_no")).toBe(true);
    // The frozen binary's exact INSERT shape must keep working.
    db.run(
      `INSERT OR IGNORE INTO messages (uuid, session_id, parent_uuid, line_no, ts, role, text, is_sidechain)
       VALUES ('u1', 'S', NULL, NULL, NULL, 'user', 'x', 0)`,
    );
    expect(db.query("SELECT COUNT(*) AS c FROM messages").get()).toEqual({ c: 1 });
    db.close();
  });

  test("per-connection pragmas apply on every open", () => {
    openDb(path).close();
    const db = openDb(path); // second open skips the DDL block
    const busy = db.query("PRAGMA busy_timeout").get() as { timeout: number };
    expect(busy.timeout).toBe(5000);
    db.close();
  });
});
