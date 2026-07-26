import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolveSession } from "../query.ts";

// Output sink for the CLI. Routing every line through this (instead of calling
// console / process directly inside the dispatch) is what makes runCli testable:
// a test passes a capturing sink and asserts on the lines and exit code without
// spawning the binary or mutating the global process.exitCode.
export interface CliIO {
  log: (line: string) => void; // a normal output line (stdout + newline)
  error: (line: string) => void; // an error line (stderr + newline)
  write: (text: string) => void; // raw stdout, no trailing newline (digest input)
  setExitCode: (code: number) => void;
}

// The single source of truth for the CLI's options. parseArgs infers the precise
// values shape from this literal, and CliValues is derived from it, so a new flag
// is automatically visible to every command handler; a hand-kept mirror interface
// could silently miss one (structural subtyping accepts extra fields). Throws on an
// unknown option; runCli turns that into a clean message + exit 1.
export const parseCliArgs = (args: string[]) =>
  parseArgs({
    args,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      full: { type: "boolean", default: false },
      rebuild: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      limit: { type: "string" },
      project: { type: "string" },
      cwd: { type: "string" },
      days: { type: "string" },
      since: { type: "string" },
      role: { type: "string" },
      prose: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      context: { type: "boolean", default: false },
      stdin: { type: "boolean", default: false },
      ids: { type: "boolean", default: false },
      model: { type: "string" },
      bytes: { type: "string" },
      range: { type: "string" },
      to: { type: "string" },
      keep: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

// The parsed option values runCli hands to a command handler, derived from the
// option table above.
export type CliValues = ReturnType<typeof parseCliArgs>["values"];

// Everything a command handler needs from runCli: the open database, the output
// sink, the parsed flags/positionals, and the shared reporting helpers. Command
// modules import from here, never from cli.ts (that would be an import cycle);
// this module is the seam between the dispatcher and the handlers.
export interface CommandContext {
  db: Database;
  io: CliIO;
  values: CliValues;
  positionals: string[];
  dbPath: string;
  limit: number | undefined;
  fail: (message: string) => void;
  emitJson: (payload: unknown) => void;
}

// Read all of stdin, degrading to "" when there is no stdin (a closed or absent
// fd 0 throws from readFileSync). The two stdin-consuming commands (relevant
// --stdin, digest write) share this so the degrade-never-throw contract is
// written once.
export const readStdin = (): string => {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
};

// Parse and validate a numeric CLI option. One place for the Number() + predicate
// + fail() block every numeric flag needs, so the rules are stated as data instead
// of being retyped per option. `value` is undefined when the option is absent, so
// the caller applies its own default; `{ ok: false }` means the message has already
// been reported and the caller must stop. `label` is the noun phrase in the error
// text, so each option keeps the exact wording its tests pin.
export const numberOption = (
  raw: string | undefined,
  name: string,
  opts: { integer?: boolean; min: number; minExclusive?: boolean; label: string },
  fail: (message: string) => void,
): { ok: true; value: number | undefined } | { ok: false } => {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = Number(raw);
  // Fractions are meaningful for some options (--days multiplies into a
  // millisecond cutoff, so 1.5 is a day and a half), so integrality is opt-in
  // rather than the rule; those options only need a finite number.
  const wellFormed = opts.integer ? Number.isInteger(value) : Number.isFinite(value);
  const aboveMin = opts.minExclusive ? value > opts.min : value >= opts.min;
  if (!wellFormed || !aboveMin) {
    fail(`--${name} must be ${opts.label} (got "${raw}")`);
    return { ok: false };
  }
  return { ok: true, value };
};

// The shared tail of a plain reader command: emit the rows as JSON, or print the
// empty state, or render the lines. Used only by the commands whose tail really is
// those three steps over one row array (search, sessions, digest search).
//
// The others deliberately keep their own tail, and needing an extra option here is
// the signal that a command belongs in this list rather than in the helper:
//   - show     validates --range first and its JSON payload is { id, total, from,
//              messages }, not the rendered rows.
//   - recent   enriches the rows with the opening prompt for JSON only.
//   - relevant is silent instead of printing an empty state in --context mode, and
//              that silence is the hook contract.
//   - digest stale has a third mode (--ids) between JSON and the listing.
//   - digest show renders one nullable summary, not a list.
//   - stats and doctor have no empty state and a JSON payload that carries fields
//              the listing does not.
export const present = <T>(
  ctx: Pick<CommandContext, "io" | "values" | "emitJson">,
  rows: T[],
  opts: { lines: (rows: T[]) => string[]; empty: string },
): void => {
  if (ctx.values.json) {
    ctx.emitJson(rows);
    return;
  }
  if (rows.length === 0) {
    ctx.io.log(opts.empty);
    return;
  }
  for (const line of opts.lines(rows)) ctx.io.log(line);
};

// Validate an ISO date CLI option (the `--since` shape, shared by search and
// sessions so the two cannot drift on what a date is). Anchored shape check plus a
// round-trip calendar check: an unanchored regex would let "2026-31-01" or trailing
// garbage through, and Date.parse alone is engine-dependent (JSC rolls "2026-02-30"
// over to March 2). A bad date would make the lexical ts comparison silently exclude
// everything instead of erroring. `{ ok: false }` means the message has already been
// reported and the caller must stop.
export const dateOption = (
  raw: string | undefined,
  name: string,
  fail: (message: string) => void,
): { ok: true; value: string | undefined } | { ok: false } => {
  if (raw === undefined) return { ok: true, value: undefined };
  const parsed = Date.parse(`${raw}T00:00:00Z`);
  const roundTrips =
    /^\d{4}-\d{2}-\d{2}$/.test(raw) &&
    !Number.isNaN(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === raw;
  if (!roundTrips) {
    fail(`--${name} must be a valid ISO date like 2026-01-31 (got "${raw}")`);
    return { ok: false };
  }
  return { ok: true, value: raw };
};

// Validate a CLI option against a closed set of allowed values, reporting them in
// the error so the user does not have to go looking in --help.
export const enumOption = (
  raw: string | undefined,
  name: string,
  allowed: readonly string[],
  fail: (message: string) => void,
): { ok: true; value: string | undefined } | { ok: false } => {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!allowed.includes(raw)) {
    fail(`--${name} must be one of ${allowed.join(" | ")} (got "${raw}")`);
    return { ok: false };
  }
  return { ok: true, value: raw };
};

// Resolve a positional session-id argument (an id or a unique prefix) to a full
// session id, reporting the right error and setting exit 1 when it is missing or
// matches nothing. Returns null in those cases so the caller can stop. Shared by
// the id-taking commands instead of each re-checking the argument. An ambiguous
// prefix still throws from resolveSession and is caught by runCli's outer handler.
export const resolveOrFail = (
  db: Database,
  idArg: string | undefined,
  label: string,
  fail: (message: string) => void,
): string | null => {
  if (!idArg) {
    fail(`${label}: missing <session-id>`);
    return null;
  }
  const sessionId = resolveSession(db, idArg);
  if (!sessionId) {
    fail(`No session matching "${idArg}".`);
    return null;
  }
  return sessionId;
};
