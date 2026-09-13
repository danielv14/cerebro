import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
