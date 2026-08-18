import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type BuildStamp, buildStamp } from "./build-stamp.ts";
import { SCHEMA_VERSION } from "./db.ts";
import { summaryCoverage } from "./digest/index.ts";
import { claudeDir, discoverSessionFiles } from "./paths.ts";

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
  const pragma = full ? "integrity_check" : "quick_check";
  try {
    const rows = db.query(`PRAGMA ${pragma}`).all() as Record<string, string>[];
    const messages = rows.map((r) => Object.values(r)[0]).filter((v) => v && v !== "ok");
    return messages.length === 0
      ? { key: "integrity", group: "Database", label: "integrity", status: "ok", detail: pragma }
      : {
          key: "integrity",
          group: "Database",
          label: "integrity",
          status: "fail",
          detail: messages.join("; "),
          remedy: "restore from a backup (see README, Backups)",
        };
  } catch (error) {
    return {
      key: "integrity",
      group: "Database",
      label: "integrity",
      status: "unknown",
      detail: (error as Error).message,
    };
  }
};

// FTS5's own consistency check: it re-derives the index from the content table and
// throws when they disagree, which is how a partially-applied schema change or a
// dropped trigger shows up.
const ftsCheck = (db: Database, table: string): Check => {
  try {
    db.run(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`);
    return { key: `fts:${table}`, group: "Database", label: table, status: "ok", detail: "ok" };
  } catch (error) {
    return {
      key: `fts:${table}`,
      group: "Database",
      label: table,
      status: "fail",
      detail: (error as Error).message,
      remedy: "cerebro index --rebuild",
    };
  }
};

const schemaCheck = (db: Database): Check => {
  const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  return version === SCHEMA_VERSION
    ? {
        key: "schema",
        group: "Database",
        label: "schema",
        status: "ok",
        detail: `v${version} (current)`,
      }
    : {
        key: "schema",
        group: "Database",
        label: "schema",
        status: "fail",
        detail: `v${version}, this build expects v${SCHEMA_VERSION}`,
        remedy:
          version > SCHEMA_VERSION
            ? "the database was written by a newer build; update this one"
            : "open the database with a current build to migrate it",
      };
};

// index_state rows whose source file is gone. The indexer prunes these (#84), so a
// non-zero count here means no index run has happened since those files were
// deleted, not that anything is broken.
const orphanedCursors = (db: Database): Check => {
  const cursors = (
    db.query("SELECT source_file FROM index_state").all() as { source_file: string }[]
  ).map((r) => r.source_file);
  if (cursors.length === 0) {
    return {
      key: "cursors",
      group: "Archive",
      label: "index cursors",
      status: "ok",
      detail: "0 rows",
    };
  }
  const present = new Set(discoverSessionFiles().map((f) => f.path));
  // An empty scan is the transient-failure case the indexer also guards against:
  // report unknown rather than declaring every cursor orphaned.
  if (present.size === 0) {
    return {
      key: "cursors",
      group: "Archive",
      label: "index cursors",
      status: "unknown",
      detail: "no session files discovered; cannot tell orphans from a failed scan",
    };
  }
  const orphans = cursors.filter((path) => !present.has(path)).length;
  return orphans === 0
    ? {
        key: "cursors",
        group: "Archive",
        label: "index cursors",
        status: "ok",
        detail: `${cursors.length} rows, no orphans`,
      }
    : {
        key: "cursors",
        group: "Archive",
        label: "index cursors",
        status: "warn",
        detail: `${orphans} of ${cursors.length} point at files that are gone`,
        remedy: "cerebro index",
      };
};

// Sessions with no user/assistant turns. They are hidden from the listings by the
// threads view (#83) but the rows stay, deliberately: the row is the sidecar
// metadata that keeps a session known after Claude Code deletes its transcript.
const emptySessions = (db: Database): Check => {
  const count = (
    db.query("SELECT COUNT(*) AS c FROM sessions WHERE msg_count = 0").get() as { c: number }
  ).c;
  return {
    key: "empty-sessions",
    group: "Archive",
    label: "empty sessions",
    status: "ok",
    detail: count === 0 ? "0" : `${count} (hidden from listings, rows kept on purpose)`,
  };
};

const digestCoverage = (db: Database): Check => {
  const { threads, summarized, stale } = summaryCoverage(db);
  const detail = `${summarized}/${threads} threads summarized, ${stale} stale`;
  // Coverage is not just a quality metric: relevant's summary tier short-circuits
  // the raw-transcript scan, so a backlog is per-prompt hook latency.
  return stale === 0
    ? { key: "digest", group: "Archive", label: "digest coverage", status: "ok", detail }
    : {
        key: "digest",
        group: "Archive",
        label: "digest coverage",
        status: "warn",
        detail,
        remedy: "run the reconciler (hooks/digest-stale-batch.sh)",
      };
};

// The WAL is folded back into the main file by `maintain`; a large one is untidy
// rather than broken, so this warns and never fails.
const WAL_WARN_BYTES = 64 * 1024 * 1024;
const walSize = (dbPath: string): Check => {
  try {
    const bytes = statSync(`${dbPath}-wal`).size;
    return {
      key: "wal",
      group: "Database",
      label: "wal",
      status: bytes > WAL_WARN_BYTES ? "warn" : "ok",
      detail: `${bytes} bytes`,
      ...(bytes > WAL_WARN_BYTES ? { remedy: "cerebro maintain" } : {}),
    };
  } catch {
    // No -wal file at all is the normal state after a truncating checkpoint.
    return { key: "wal", group: "Database", label: "wal", status: "ok", detail: "0 bytes" };
  }
};

// Where `deploy` puts the compiled binary; kept as one expression so doctor and the
// deploy script cannot disagree about the path.
export const deployedBinaryPath = (): string =>
  join(process.env.CLAUDE_CONFIG_DIR || claudeDir(), "cerebro", "cerebro");

// The drift check this whole stamp exists for: ask the deployed binary what it was
// built from and compare it against the binary doing the asking.
const deployedDrift = (running: BuildStamp): Check => {
  const path = deployedBinaryPath();
  const base = { key: "deployed", group: "Build", label: "deployed" };
  if (!existsSync(path)) {
    return {
      ...base,
      status: "unknown",
      detail: `no binary at ${path}`,
      remedy: "bun run deploy",
    };
  }
  let deployedLine: string;
  try {
    const proc = Bun.spawnSync([path, "version"], { stdout: "pipe", stderr: "pipe" });
    deployedLine = new TextDecoder().decode(proc.stdout).trim().split("\n")[0] ?? "";
    if (!deployedLine) throw new Error("no output");
  } catch (error) {
    return { ...base, status: "unknown", detail: `could not run it: ${(error as Error).message}` };
  }
  // A binary built before the stamp existed answers something else entirely, which
  // is itself proof that it is behind.
  const deployedCommit = /\(([0-9a-f]{7,40}),/.exec(deployedLine)?.[1];
  if (!deployedCommit) {
    return {
      ...base,
      status: "warn",
      detail: "deployed binary predates the build stamp",
      remedy: "bun run deploy",
    };
  }
  if (!running.stamped) {
    // Running from source: there is no commit to compare against, and saying
    // "behind" would be a guess.
    return {
      ...base,
      status: "unknown",
      detail: `${deployedCommit} (running from source, nothing to compare)`,
    };
  }
  return deployedCommit === running.commit
    ? { ...base, status: "ok", detail: `${deployedCommit}, matches this build` }
    : {
        ...base,
        status: "warn",
        detail: `${deployedCommit}, this build is ${running.commit}`,
        remedy: "bun run deploy",
      };
};

// Whether the hook that drives the automated path is wired at all. Reported, never
// edited: doctor does not touch settings.json. A list of one because cerebro ships one
// hook; per-prompt relevance injection was removed (see docs/hooks.md).
const hookWiring = (): Check[] => {
  const path = join(claudeDir(), "settings.json");
  const wanted = [{ key: "SessionEnd", label: "SessionEnd", what: "index + summarize on /clear" }];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return wanted.map((w) => ({
      key: `hook:${w.key}`,
      group: "Hooks",
      label: w.label,
      status: "unknown" as const,
      detail: `could not read ${path}`,
    }));
  }
  let settings: unknown;
  try {
    settings = JSON.parse(raw);
  } catch {
    return wanted.map((w) => ({
      key: `hook:${w.key}`,
      group: "Hooks",
      label: w.label,
      status: "unknown" as const,
      detail: `${path} is not valid JSON`,
    }));
  }
  const hooks = (settings as { hooks?: Record<string, unknown> }).hooks ?? {};
  return wanted.map((w) => {
    // A substring test on the serialized entry rather than a walk of the hook
    // schema: the shape is Claude Code's, not cerebro's, and it can change.
    const entry = JSON.stringify(hooks[w.key] ?? null);
    const wired = entry.includes("cerebro");
    return {
      key: `hook:${w.key}`,
      group: "Hooks",
      label: w.label,
      status: wired ? ("ok" as const) : ("warn" as const),
      detail: wired ? w.what : "not wired to cerebro",
      ...(wired ? {} : { remedy: `add a ${w.key} hook (see README, Automation)` }),
    };
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
