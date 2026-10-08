import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { type BuildStamp, buildStamp } from "./build-stamp.ts";
import { count, SCHEMA_VERSION } from "./db.ts";
import { summaryCoverage } from "./digest/stale.ts";
import { countCursors, orphanedCursorPaths } from "./scan.ts";
import type { SourceAdapter } from "./sources/adapter.ts";
import { discoverAllSessionFiles } from "./sources/registry.ts";

// Read-only by construction: doctor never repairs, it names the command that
// does.

export type CheckStatus = "ok" | "warn" | "fail" | "unknown";

export interface Check {
  key: string;
  group: string;
  label: string;
  status: CheckStatus;
  detail: string;
  remedy?: string;
}

// Identity declared once per check: rebuilding the literal per branch would let a
// typo hand --json consumers two keys for the same check.
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

export interface SkippedKind {
  kind: string;
  count: number;
  sample: string;
}

export interface DoctorReport {
  build: BuildStamp;
  checks: Check[];
  // Informational only, never part of `ok`; present under --full.
  skipped?: SkippedKind[];
  ok: boolean;
}

// quick_check by default: integrity_check walks every page and is slow on a large
// archive.
const integrityCheck = (db: Database, full: boolean): Check => {
  const check = defineCheck({ key: "integrity", group: "Database", label: "integrity" });
  const pragma = full ? "integrity_check" : "quick_check";
  try {
    const rows = db.query(`PRAGMA ${pragma}`).all() as Record<string, string>[];
    const messages = rows.map((r) => Object.values(r)[0]).filter((v) => v && v !== "ok");
    return messages.length === 0
      ? check.ok(pragma)
      : check.fail(messages.join("; "), "restore from a backup (see docs/operations.md)");
  } catch (error) {
    return check.unknown((error as Error).message);
  }
};

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

const orphanedCursors = (db: Database, adapters: SourceAdapter[]): Check => {
  const check = defineCheck({ key: "cursors", group: "Archive", label: "index cursors" });
  const cursors = countCursors(db);
  if (cursors === 0) return check.ok("0 rows");
  const orphans = orphanedCursorPaths(db, discoverAllSessionFiles(adapters));
  if (orphans === null) {
    return check.unknown("no session files discovered; cannot tell orphans from a failed scan");
  }
  return orphans.length === 0
    ? check.ok(`${cursors} rows, no orphans`)
    : check.warn(`${orphans.length} of ${cursors} point at files that are gone`, "cerebro index");
};

const emptySessions = (db: Database): Check => {
  const empty = count(db, "SELECT COUNT(*) AS c FROM sessions WHERE msg_count = 0");
  return defineCheck({ key: "empty-sessions", group: "Archive", label: "empty sessions" }).ok(
    empty === 0 ? "0" : `${empty} (hidden from listings, rows kept on purpose)`,
  );
};

const digestCoverage = (db: Database): Check => {
  const check = defineCheck({ key: "digest", group: "Archive", label: "digest coverage" });
  const { threads, summarized, stale, failing } = summaryCoverage(db);
  const failed = failing > 0 ? ` (${failing} failing, see cerebro digest stale)` : "";
  const detail = `${summarized}/${threads} threads summarized, ${stale} stale${failed}`;
  return stale === 0
    ? check.ok(detail)
    : check.warn(detail, "run the reconciler (hooks/digest-stale-batch.sh)");
};

// A large WAL is untidy, not broken: warn, never fail.
const WAL_WARN_BYTES = 64 * 1024 * 1024;
const walSize = (dbPath: string): Check => {
  const check = defineCheck({ key: "wal", group: "Database", label: "wal" });
  try {
    const bytes = statSync(`${dbPath}-wal`).size;
    return bytes > WAL_WARN_BYTES
      ? check.warn(`${bytes} bytes`, "cerebro maintain")
      : check.ok(`${bytes} bytes`);
  } catch {
    // No -wal file is the normal state after a truncating checkpoint.
    return check.ok("0 bytes");
  }
};

const deployedDrift = (running: BuildStamp, path: string): Check => {
  const check = defineCheck({ key: "deployed", group: "Build", label: "deployed" });
  if (!existsSync(path)) return check.unknown(`no binary at ${path}`, "bun run deploy");
  let deployedLine: string;
  try {
    const proc = Bun.spawnSync([path, "version"], { stdout: "pipe", stderr: "pipe" });
    deployedLine = new TextDecoder().decode(proc.stdout).trim().split("\n")[0] ?? "";
    if (!deployedLine) throw new Error("no output");
  } catch (error) {
    return check.unknown(`could not run it: ${(error as Error).message}`);
  }
  const deployedCommit = /\(([0-9a-f]{7,40}),/.exec(deployedLine)?.[1];
  if (!deployedCommit) {
    return check.warn("deployed binary predates the build stamp", "bun run deploy");
  }
  if (!running.stamped) {
    return check.unknown(`${deployedCommit} (running from source, nothing to compare)`);
  }
  return deployedCommit === running.commit
    ? check.ok(`${deployedCommit}, matches this build`)
    : check.warn(`${deployedCommit}, this build is ${running.commit}`, "bun run deploy");
};

const hookWiring = (path: string): Check => {
  const check = defineCheck({ key: "hook:SessionEnd", group: "Hooks", label: "SessionEnd" });
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return check.unknown(`could not read ${path}`);
  }
  let settings: unknown;
  try {
    settings = JSON.parse(raw);
  } catch {
    return check.unknown(`${path} is not valid JSON`);
  }
  const hooks = (settings as { hooks?: Record<string, unknown> }).hooks ?? {};
  // A substring test rather than a walk of the hook schema: the shape is Claude
  // Code's, not cerebro's, and it can change.
  const entry = JSON.stringify(hooks.SessionEnd ?? null);
  return entry.includes("cerebro")
    ? check.ok("index + summarize on /clear")
    : check.warn("not wired to cerebro", "add a SessionEnd hook (see README, Automation)");
};

const longestString = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return "";
  let longest = "";
  for (const child of Object.values(value)) {
    const text = longestString(child);
    if (text.length > longest.length) longest = text;
  }
  return longest;
};

const SAMPLE_CHARS = 80;

// Reads every transcript, which is why it waits for --full. The sample comes from
// the kind's longest text, since a kind that carries long text is the one that
// might deserve indexing.
const skippedLineKinds = (adapters: SourceAdapter[]): SkippedKind[] => {
  const byKind = new Map<string, { count: number; text: string }>();
  for (const adapter of adapters) {
    for (const file of adapter.discover()) {
      let content: string;
      try {
        content = readFileSync(file.path, "utf8");
      } catch {
        continue;
      }
      for (const line of adapter.classifyLines(content.split("\n"))) {
        if (line.kind !== "skip") continue;
        const { lineKind, payload } = adapter.describeSkipped(line.raw);
        const text = longestString(payload);
        const seen = byKind.get(lineKind);
        if (!seen) byKind.set(lineKind, { count: 1, text });
        else {
          seen.count++;
          if (text.length > seen.text.length) seen.text = text;
        }
      }
    }
  }
  return [...byKind]
    .map(([kind, { count, text }]) => {
      const flat = text.replace(/\s+/g, " ").trim();
      const sample = flat.length > SAMPLE_CHARS ? `${flat.slice(0, SAMPLE_CHARS)}…` : flat;
      return { kind, count, sample };
    })
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
};

export interface DoctorOptions {
  deployedBinary: string;
  settingsFile: string;
  adapters: SourceAdapter[];
  full?: boolean;
}

export const runDoctor = (db: Database, dbPath: string, opts: DoctorOptions): DoctorReport => {
  const build = buildStamp();
  const full = opts.full ?? false;
  const checks: Check[] = [
    deployedDrift(build, opts.deployedBinary),
    schemaCheck(db),
    integrityCheck(db, full),
    ftsCheck(db, "messages_fts"),
    ftsCheck(db, "summaries_fts"),
    walSize(dbPath),
    orphanedCursors(db, opts.adapters),
    emptySessions(db),
    digestCoverage(db),
    hookWiring(opts.settingsFile),
  ];
  return {
    build,
    checks,
    ...(full ? { skipped: skippedLineKinds(opts.adapters) } : {}),
    ok: !checks.some((c) => c.status === "fail"),
  };
};
