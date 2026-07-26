import { statSync } from "node:fs";
import { buildStampLine } from "../build-stamp.ts";
import { type Check, type DoctorReport, runDoctor } from "../doctor.ts";
import { humanBytes } from "../render.ts";
import type { CommandContext } from "./context.ts";

// A status marker wide enough to align every row, so failures are scannable in a
// wall of ok.
const MARKER: Record<Check["status"], string> = {
  ok: "ok  ",
  warn: "warn",
  fail: "FAIL",
  unknown: "?   ",
};

// `doctor` output: the running build, then the checks under their group headings,
// then a one-line verdict. Grouped in the order runDoctor emits them, so the
// listing and the --json array stay in the same sequence.
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

// The `doctor` command: one read-only health report over the archive, the schema,
// the digest backlog, the deployed binary and the hook wiring. Exits 1 only on a
// hard failure (corruption, a schema this build cannot speak), so it is usable as a
// cron or CI-style guard without going red on a warning. The report itself is the
// error message, so nothing is printed twice on the way out.
export const doctorCommand = ({ db, io, values, dbPath, emitJson }: CommandContext): void => {
  const report = runDoctor(db, dbPath, { full: values.full });
  let dbBytes: number | null = null;
  try {
    dbBytes = statSync(dbPath).size;
  } catch {
    dbBytes = null;
  }
  if (values.json) emitJson({ ...report, dbPath, dbBytes });
  else for (const line of doctorReport(report, dbPath, dbBytes)) io.log(line);
  if (!report.ok) io.setExitCode(1);
};
