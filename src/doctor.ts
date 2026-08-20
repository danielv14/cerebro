import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type BuildStamp, buildStamp } from "./build-stamp.ts";
import { SCHEMA_VERSION } from "./db.ts";
import { summaryCoverage } from "./digest/index.ts";
import { claudeDir, discoverSessionFiles } from "./paths.ts";
import { orphanedCursorPaths } from "./scan.ts";

// The health report `cerebro doctor` renders. Read-only by construction: doctor
// never repairs, prunes, optimizes or deploys, it reports and names the command
// that fixes each thing. A diagnostic that mutates is not trustworthy on an archive
// that is the only copy of sessions Claude Code has already deleted.

// One check's outcome. "warn" is informational and does not fail the run; only
// "fail" sets exit 1, so doctor is usable as a cron guard without going red on a
// large WAL or a not-yet-drained digest backlog. "unknown" is what a check degrades
// to when its input is unreadable (a missing binary, an unparseable settings.json):
// every check degrades independently, the same tolerance rule as gitInfo
// (invariant #9).
export type CheckStatus = "ok" | "warn" | "fail" | "unknown";

export interface Check {
  // Stable machine key for --json consumers.
  key: string;
  group: string;
  label: string;
  status: CheckStatus;
  detail: string;
  // What to run to fix it, when there is such a command.
  remedy?: string;
}

// A check's identity plus one method per outcome. Every check declares its key,
// group and label once and builds each branch from that, instead of rebuilding the
// whole Check literal three or four times: a typo in one branch would hand `--json`
// consumers two different keys for the same check, and nothing would catch it.
//
// `remedy` stays absent rather than undefined when a branch has no command to name,
// so the JSON payload keeps the shape it has always had.
interface CheckOutcomes {
  ok: (detail: string, remedy?: string) => Check;
  warn: (detail: string, remedy?: string) => Check;
  fail: (detail: string, remedy?: string) => Check;
  unknown: (detail: string, remedy?: string) => Check;
}

const defineCheck = (identity: Pick<Check, "key" | "group" | "label">): CheckOutcomes => {
  const outcome =
    (status: CheckStatus) =>
    (detail: string, remedy?: string): Check => ({
      ...identity,
      status,
      detail,
      ...(remedy === undefined ? {} : { remedy }),
    });
  return {
    ok: outcome("ok"),
    warn: outcome("warn"),
    fail: outcome("fail"),
    unknown: outcome("unknown"),
  };
};

export interface DoctorReport {
  build: BuildStamp;
  checks: Check[];
  ok: boolean;
}

// SQLite's own structural check. quick_check is the default because
// integrity_check walks every page and is not instant on a multi-hundred-megabyte
// archive, while quick_check catches the corruption that actually happens
// (malformed records, broken b-tree links) and skips only the cross-page index
// verification. `--full` opts into the slower, complete form.
const integrityCheck = (db: Database, full: boolean): Check => {
  const check = defineCheck({ key: "integrity", group: "Database", label: "integrity" });
  const pragma = full ? "integrity_check" : "quick_check";
  try {
    const rows = db.query(`PRAGMA ${pragma}`).all() as Record<string, string>[];
    const messages = rows.map((r) => Object.values(r)[0]).filter((v) => v && v !== "ok");
    return messages.length === 0
      ? check.ok(pragma)
      : check.fail(messages.join("; "), "restore from a backup (see README, Backups)");
  } catch (error) {
    return check.unknown((error as Error).message);
  }
};

// FTS5's own consistency check: it re-derives the index from the content table and
// throws when they disagree, which is how a partially-applied schema change or a
// dropped trigger shows up.
const ftsCheck = (db: Database, table: string): Check => {
  const check = defineCheck({ key: `fts:${table}`, group: "Database", label: table });
  try {
    db.run(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`);
    return check.ok("ok");
  } catch (error) {
    return check.fail((error as Error).message, "cerebro index --rebuild");
  }
};

const schemaCheck = (db: Database): Check => {
  const check = defineCheck({ key: "schema", group: "Database", label: "schema" });
  const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  return version === SCHEMA_VERSION
    ? check.ok(`v${version} (current)`)
    : check.fail(
        `v${version}, this build expects v${SCHEMA_VERSION}`,
        version > SCHEMA_VERSION
          ? "the database was written by a newer build; update this one"
          : "open the database with a current build to migrate it",
      );
};

// index_state rows whose source file is gone. The indexer prunes these (#84), so a
// non-zero count here means no index run has happened since those files were
// deleted, not that anything is broken. Counted through orphanedCursorPaths, the
// same reader the prune deletes through, so this check can never disagree with
// what `cerebro index` would actually remove. Read-only: the counting form issues
// no writes.
const orphanedCursors = (db: Database): Check => {
  const check = defineCheck({ key: "cursors", group: "Archive", label: "index cursors" });
  const cursors = (db.query("SELECT COUNT(*) AS c FROM index_state").get() as { c: number }).c;
  if (cursors === 0) return check.ok("0 rows");
  // null = empty scan, the transient-failure case the reader guards against:
  // report unknown rather than declaring every cursor orphaned.
  const orphans = orphanedCursorPaths(db, discoverSessionFiles());
  if (orphans === null) {
    return check.unknown("no session files discovered; cannot tell orphans from a failed scan");
  }
  return orphans.length === 0
    ? check.ok(`${cursors} rows, no orphans`)
    : check.warn(`${orphans.length} of ${cursors} point at files that are gone`, "cerebro index");
};

// Sessions with no user/assistant turns. They are hidden from the listings by the
// threads view (#83) but the rows stay, deliberately: the row is the sidecar
// metadata that keeps a session known after Claude Code deletes its transcript.
const emptySessions = (db: Database): Check => {
  const count = (
    db.query("SELECT COUNT(*) AS c FROM sessions WHERE msg_count = 0").get() as { c: number }
  ).c;
  return defineCheck({ key: "empty-sessions", group: "Archive", label: "empty sessions" }).ok(
    count === 0 ? "0" : `${count} (hidden from listings, rows kept on purpose)`,
  );
};

const digestCoverage = (db: Database): Check => {
  const check = defineCheck({ key: "digest", group: "Archive", label: "digest coverage" });
  const { threads, summarized, stale } = summaryCoverage(db);
  const detail = `${summarized}/${threads} threads summarized, ${stale} stale`;
  // Coverage is not just a quality metric: relevant's summary tier short-circuits
  // the raw-transcript scan, so a backlog is per-prompt hook latency.
  return stale === 0
    ? check.ok(detail)
    : check.warn(detail, "run the reconciler (hooks/digest-stale-batch.sh)");
};

// The WAL is folded back into the main file by `maintain`; a large one is untidy
// rather than broken, so this warns and never fails.
const WAL_WARN_BYTES = 64 * 1024 * 1024;
const walSize = (dbPath: string): Check => {
  const check = defineCheck({ key: "wal", group: "Database", label: "wal" });
  try {
    const bytes = statSync(`${dbPath}-wal`).size;
    return bytes > WAL_WARN_BYTES
      ? check.warn(`${bytes} bytes`, "cerebro maintain")
      : check.ok(`${bytes} bytes`);
  } catch {
    // No -wal file at all is the normal state after a truncating checkpoint.
    return check.ok("0 bytes");
  }
};

// Where `deploy` puts the compiled binary; kept as one expression so doctor and the
// deploy script cannot disagree about the path.
export const deployedBinaryPath = (): string =>
  join(process.env.CLAUDE_CONFIG_DIR || claudeDir(), "cerebro", "cerebro");

// The drift check this whole stamp exists for: ask the deployed binary what it was
// built from and compare it against the binary doing the asking.
const deployedDrift = (running: BuildStamp): Check => {
  const check = defineCheck({ key: "deployed", group: "Build", label: "deployed" });
  const path = deployedBinaryPath();
  if (!existsSync(path)) return check.unknown(`no binary at ${path}`, "bun run deploy");
  let deployedLine: string;
  try {
    const proc = Bun.spawnSync([path, "version"], { stdout: "pipe", stderr: "pipe" });
    deployedLine = new TextDecoder().decode(proc.stdout).trim().split("\n")[0] ?? "";
    if (!deployedLine) throw new Error("no output");
  } catch (error) {
    return check.unknown(`could not run it: ${(error as Error).message}`);
  }
  // A binary built before the stamp existed answers something else entirely, which
  // is itself proof that it is behind.
  const deployedCommit = /\(([0-9a-f]{7,40}),/.exec(deployedLine)?.[1];
  if (!deployedCommit) {
    return check.warn("deployed binary predates the build stamp", "bun run deploy");
  }
  if (!running.stamped) {
    // Running from source: there is no commit to compare against, and saying
    // "behind" would be a guess.
    return check.unknown(`${deployedCommit} (running from source, nothing to compare)`);
  }
  return deployedCommit === running.commit
    ? check.ok(`${deployedCommit}, matches this build`)
    : check.warn(`${deployedCommit}, this build is ${running.commit}`, "bun run deploy");
};

// Whether the hook that drives the automated path is wired at all. Reported, never
// edited: doctor does not touch settings.json. A list of one because cerebro ships one
// hook; per-prompt relevance injection was removed (see docs/hooks.md).
const hookWiring = (): Check[] => {
  const path = join(claudeDir(), "settings.json");
  const wanted = [{ key: "SessionEnd", label: "SessionEnd", what: "index + summarize on /clear" }];
  const checks = wanted.map((hook) => ({
    ...hook,
    check: defineCheck({ key: `hook:${hook.key}`, group: "Hooks", label: hook.label }),
  }));
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return checks.map(({ check }) => check.unknown(`could not read ${path}`));
  }
  let settings: unknown;
  try {
    settings = JSON.parse(raw);
  } catch {
    return checks.map(({ check }) => check.unknown(`${path} is not valid JSON`));
  }
  const hooks = (settings as { hooks?: Record<string, unknown> }).hooks ?? {};
  return checks.map(({ key, what, check }) => {
    // A substring test on the serialized entry rather than a walk of the hook
    // schema: the shape is Claude Code's, not cerebro's, and it can change.
    const entry = JSON.stringify(hooks[key] ?? null);
    return entry.includes("cerebro")
      ? check.ok(what)
      : check.warn("not wired to cerebro", `add a ${key} hook (see README, Automation)`);
  });
};

// Collect every check. `full` swaps quick_check for the complete integrity_check.
export const runDoctor = (
  db: Database,
  dbPath: string,
  opts: { full?: boolean } = {},
): DoctorReport => {
  const build = buildStamp();
  const checks: Check[] = [
    deployedDrift(build),
    schemaCheck(db),
    integrityCheck(db, opts.full ?? false),
    ftsCheck(db, "messages_fts"),
    ftsCheck(db, "summaries_fts"),
    walSize(dbPath),
    orphanedCursors(db),
    emptySessions(db),
    digestCoverage(db),
    ...hookWiring(),
  ];
  // Only a hard failure (corruption, a schema this build cannot speak) is worth a
  // non-zero exit; warnings are things to get around to.
  return { build, checks, ok: !checks.some((c) => c.status === "fail") };
};
