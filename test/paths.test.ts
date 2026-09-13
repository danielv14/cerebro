import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  claudeProjectsDir,
  defaultDbPath,
  deployedBinaryPath,
  settingsPath,
} from "../src/paths.ts";

// The binary and settings paths are the two doctor probes, and `bun run deploy`
// plus both hook scripts build them from their own bash literals. Drift between
// the four is the bug this pins: deploy installing where the hooks do not look.
describe("Claude config directory resolution", () => {
  const saved: Record<string, string | undefined> = {};
  const VARS = ["CLAUDE_CONFIG_DIR", "CEREBRO_CLAUDE_DIR", "CEREBRO_DB"];

  beforeEach(() => {
    for (const name of VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const name of VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  test("defaults to ~/.claude", () => {
    expect(deployedBinaryPath()).toBe(join(homedir(), ".claude", "cerebro", "cerebro"));
    expect(settingsPath()).toBe(join(homedir(), ".claude", "settings.json"));
    expect(claudeProjectsDir()).toBe(join(homedir(), ".claude", "projects"));
    expect(defaultDbPath()).toBe(join(homedir(), ".claude", "cerebro", "archive.sqlite"));
  });

  test("CLAUDE_CONFIG_DIR moves the binary, the settings file and the projects root together", () => {
    process.env.CLAUDE_CONFIG_DIR = "/tmp/elsewhere";
    expect(deployedBinaryPath()).toBe(join("/tmp/elsewhere", "cerebro", "cerebro"));
    expect(settingsPath()).toBe(join("/tmp/elsewhere", "settings.json"));
    expect(claudeProjectsDir()).toBe(join("/tmp/elsewhere", "projects"));
    // The archive moves with the installation, so an existing one is left behind
    // rather than migrated: docs/operations.md tells the reader to move it.
    expect(defaultDbPath()).toBe(join("/tmp/elsewhere", "cerebro", "archive.sqlite"));
  });

  test("CEREBRO_CLAUDE_DIR redirects the transcripts without moving the config probes", () => {
    process.env.CLAUDE_CONFIG_DIR = "/tmp/elsewhere";
    process.env.CEREBRO_CLAUDE_DIR = "/tmp/fixture";
    expect(claudeProjectsDir()).toBe(join("/tmp/fixture", "projects"));
    expect(deployedBinaryPath()).toBe(join("/tmp/elsewhere", "cerebro", "cerebro"));
    expect(settingsPath()).toBe(join("/tmp/elsewhere", "settings.json"));
    // The archive follows the transcripts, so a fixture run is fully sandboxed.
    expect(defaultDbPath()).toBe(join("/tmp/fixture", "cerebro", "archive.sqlite"));
  });
});

// The same directory is spelled out in bash three more times: `bun run deploy`
// resolves where to install, and each hook script resolves where to find the
// binary. They are edited in separate files and nothing reads them together, so
// drift is silent: deploy writes where the hooks do not look. These run the real
// assignment out of each file and compare it to the TypeScript answer.
describe("the bash copies of the cerebro directory", () => {
  const CONFIG_DIR = "/tmp/cerebro-path-drift";

  // Runs one extracted assignment under `set -u` with a pinned environment and
  // prints what the variable resolved to.
  const resolve = (assignment: string, env: Record<string, string>, variable: string): string => {
    const proc = Bun.spawnSync(
      ["bash", "-c", `set -u\n${assignment}\nprintf '%s' "$${variable}"`],
      {
        env: { HOME: "/tmp/fake-home", ...env },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = new TextDecoder().decode(proc.stderr);
    if (proc.exitCode !== 0) throw new Error(`bash failed: ${stderr}`);
    return new TextDecoder().decode(proc.stdout);
  };

  const assignmentIn = (file: string, variable: string): string => {
    const line = readFileSync(file, "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${variable}=`));
    if (!line) throw new Error(`no ${variable}= assignment in ${file}`);
    return line;
  };

  // The deploy script is one long && chain in package.json; take just its DEST step.
  const deployAssignment = (): string => {
    const deploy = JSON.parse(readFileSync("package.json", "utf8")).scripts.deploy as string;
    const step = deploy.split("&&").find((part) => part.trim().startsWith("DEST="));
    if (!step) throw new Error("no DEST= step in the deploy script");
    return step.trim();
  };

  const HOOKS = ["hooks/summarize-on-clear.sh", "hooks/digest-stale-batch.sh"];

  test("deploy installs the binary where deployedBinaryPath looks for it", () => {
    // Unset on both sides: each resolves against its own home, so compare shapes.
    expect(join(resolve(deployAssignment(), {}, "DEST"), "cerebro")).toBe(
      "/tmp/fake-home/.claude/cerebro/cerebro",
    );
    expect(deployedBinaryPath()).toBe(join(homedir(), ".claude", "cerebro", "cerebro"));

    // Set on both sides: the two answers are the same absolute path or deploy
    // installs somewhere doctor does not probe.
    process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
    const dest = resolve(deployAssignment(), { CLAUDE_CONFIG_DIR: CONFIG_DIR }, "DEST");
    expect(join(dest, "cerebro")).toBe(deployedBinaryPath());
  });

  test("both hooks find the binary where deploy installs it", () => {
    for (const hook of HOOKS) {
      const assignment = assignmentIn(hook, "CEREBRO");
      expect(resolve(assignment, {}, "CEREBRO")).toBe("/tmp/fake-home/.claude/cerebro/cerebro");
      expect(resolve(assignment, { CLAUDE_CONFIG_DIR: CONFIG_DIR }, "CEREBRO")).toBe(
        `${CONFIG_DIR}/cerebro/cerebro`,
      );
      // CEREBRO_BIN still wins over both, for a hook pointed at a one-off build.
      expect(resolve(assignment, { CEREBRO_BIN: "/opt/cerebro" }, "CEREBRO")).toBe("/opt/cerebro");
    }
  });

  test("the two hooks resolve identically to each other", () => {
    const [first, second] = HOOKS.map((hook) => assignmentIn(hook, "CEREBRO"));
    expect(first).toBe(second);
  });
});
