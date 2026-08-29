import { buildStampLine } from "../build-stamp.ts";
import { dbFileSize } from "../db.ts";
import { type Check, type DoctorReport, runDoctor } from "../doctor.ts";
import { humanBytes } from "../render.ts";
import { flag, type OptionTable } from "./args.ts";
import { defineCommand } from "./command.ts";

// Fixed-width so failures are scannable in a wall of ok.
const MARKER: Record<Check["status"], string> = {
  ok: "ok  ",
  warn: "warn",
  fail: "FAIL",
  unknown: "?   ",
};

// Grouped in the order runDoctor emits them, so the listing and the --json array
// stay in the same sequence.
export const doctorReport = (
  report: DoctorReport,
  dbPath: string,
  dbBytes: number | null,
): string[] => {
  const lines = [
    `running    ${buildStampLine(report.build)}`,
    `database   ${dbPath}${dbBytes === null ? "" : ` (${humanBytes(dbBytes)})`}`,
  ];
  let group = "";
  for (const check of report.checks) {
    if (check.group !== group) {
      group = check.group;
      lines.push("", group);
    }
    const remedy = check.remedy ? `  -> ${check.remedy}` : "";
    lines.push(`  ${MARKER[check.status]}  ${check.label.padEnd(18)}${check.detail}${remedy}`);
  }
  const failed = report.checks.filter((c) => c.status === "fail").length;
  const warned = report.checks.filter((c) => c.status === "warn").length;
  lines.push(
    "",
    failed > 0
      ? `${failed} check(s) FAILED, ${warned} warning(s).`
      : warned > 0
        ? `All checks passed, ${warned} warning(s).`
        : "All checks passed.",
  );
  return lines;
};

const options = { full: flag(), json: flag() } satisfies OptionTable;

// The report itself is the error message, so nothing is printed twice on the way
// out.
export const doctorCommand = defineCommand({
  options,
  run: ({ db, args, dbPath }) => {
    const report = runDoctor(db, dbPath, { full: args.full });
    const dbBytes = dbFileSize(dbPath);
    return {
      json: { ...report, dbPath, dbBytes },
      lines: doctorReport(report, dbPath, dbBytes),
      exitCode: report.ok ? 0 : 1,
    };
  },
});
