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

// File level, so both describes run against a clean environment and neither leaks
// an override into the files bun runs after this one in the same process. A
// developer with CLAUDE_CONFIG_DIR exported is exactly who these paths are for.
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

// The binary and settings paths are the two doctor probes, and `bun run deploy`
// plus both hook scripts build them from their own bash literals. Drift between
// the four is the bug this pins: deploy installing where the hooks do not look.
describe("Claude config directory resolution", () => {
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

describe("the bash copies of the cerebro directory", () => {
  const CONFIG_DIR = "/tmp/cerebro-path-drift";
  const repoRoot = join(import.meta.dir, "..");

  const resolve = (assignment: string, env: Record<string, string>, variable: string): string => {
    const proc = Bun.spawnSync(
      ["bash", "-c", `set -u\n${assignment}\nprintf '%s' "$${variable}"`],
      {
        env: { HOME: "/tmp/fake-home", ...env },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (proc.exitCode !== 0) {
      throw new Error(`bash failed: ${new TextDecoder().decode(proc.stderr)}`);
    }
    return new TextDecoder().decode(proc.stdout);
  };

  const hookAssignment = (hook: string): string => {
    const line = readFileSync(join(repoRoot, "hooks", hook), "utf8")
      .split("\n")
      .find((l) => l.startsWith("CEREBRO="));
    if (!line) throw new Error(`no CEREBRO= assignment in ${hook}`);
    return line;
  };

  // Both the directory and the filename deploy installs under: the same silent
  // failure either way, since doctor probes one exact path.
  const deployInstall = (): string => {
    const deploy = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts
      .deploy as string;
    const steps = deploy.split("&&").map((step) => step.trim());
    const dest = steps.find((step) => step.startsWith("DEST="));
    const copy = steps.find((step) => step.startsWith("cp dist/cerebro "));
    if (!dest || !copy) throw new Error("the deploy script no longer has a DEST= and a cp step");
    return `${dest}\nINSTALLED=${copy.slice("cp dist/cerebro ".length).trim()}`;
  };

  const HOOKS = ["summarize-on-clear.sh", "digest-stale-batch.sh"];

  test("deploy installs the binary at the path deployedBinaryPath probes", () => {
    // Unset on both sides: each resolves against its own home, so compare shapes.
    expect(resolve(deployInstall(), {}, "INSTALLED")).toBe(
      "/tmp/fake-home/.claude/cerebro/cerebro",
    );
    expect(deployedBinaryPath()).toBe(join(homedir(), ".claude", "cerebro", "cerebro"));

    // Set on both sides: the two answers are the same absolute path, or deploy
    // installs somewhere doctor does not probe.
    process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
    expect(resolve(deployInstall(), { CLAUDE_CONFIG_DIR: CONFIG_DIR }, "INSTALLED")).toBe(
      deployedBinaryPath(),
    );
  });

  test("both hooks find the binary where deploy installs it", () => {
    for (const hook of HOOKS) {
      const assignment = hookAssignment(hook);
      expect(resolve(assignment, {}, "CEREBRO")).toBe("/tmp/fake-home/.claude/cerebro/cerebro");
      expect(resolve(assignment, { CLAUDE_CONFIG_DIR: CONFIG_DIR }, "CEREBRO")).toBe(
        `${CONFIG_DIR}/cerebro/cerebro`,
      );
      // CEREBRO_BIN still wins over both, for a hook pointed at a one-off build.
      expect(resolve(assignment, { CEREBRO_BIN: "/opt/cerebro" }, "CEREBRO")).toBe("/opt/cerebro");
    }
  });
});
