import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeProjectsDir, deployedBinaryPath, settingsPath } from "../src/paths.ts";

// The binary and settings paths are the two doctor probes, and `bun run deploy`
// plus both hook scripts build them from their own bash literals. Drift between
// the four is the bug this pins: deploy installing where the hooks do not look.
describe("Claude config directory resolution", () => {
  let configDir: string | undefined;
  let claudeDir: string | undefined;

  beforeEach(() => {
    configDir = process.env.CLAUDE_CONFIG_DIR;
    claudeDir = process.env.CEREBRO_CLAUDE_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CEREBRO_CLAUDE_DIR;
  });
  afterEach(() => {
    if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = configDir;
    if (claudeDir === undefined) delete process.env.CEREBRO_CLAUDE_DIR;
    else process.env.CEREBRO_CLAUDE_DIR = claudeDir;
  });

  test("defaults to ~/.claude", () => {
    expect(deployedBinaryPath()).toBe(join(homedir(), ".claude", "cerebro", "cerebro"));
    expect(settingsPath()).toBe(join(homedir(), ".claude", "settings.json"));
    expect(claudeProjectsDir()).toBe(join(homedir(), ".claude", "projects"));
  });

  test("CLAUDE_CONFIG_DIR moves the binary, the settings file and the projects root together", () => {
    process.env.CLAUDE_CONFIG_DIR = "/tmp/elsewhere";
    expect(deployedBinaryPath()).toBe(join("/tmp/elsewhere", "cerebro", "cerebro"));
    expect(settingsPath()).toBe(join("/tmp/elsewhere", "settings.json"));
    expect(claudeProjectsDir()).toBe(join("/tmp/elsewhere", "projects"));
  });

  test("CEREBRO_CLAUDE_DIR redirects the transcripts without moving the config probes", () => {
    process.env.CLAUDE_CONFIG_DIR = "/tmp/elsewhere";
    process.env.CEREBRO_CLAUDE_DIR = "/tmp/fixture";
    expect(claudeProjectsDir()).toBe(join("/tmp/fixture", "projects"));
    expect(deployedBinaryPath()).toBe(join("/tmp/elsewhere", "cerebro", "cerebro"));
    expect(settingsPath()).toBe(join("/tmp/elsewhere", "settings.json"));
  });
});
