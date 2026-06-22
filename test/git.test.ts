import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { gitInfo } from "../src/git.ts";

/** Create a throwaway temp dir cleaned up on teardown. */
const tempDir = (): { path: string; cleanup: () => void } => {
  const p = mkdtempSync(join(tmpdir(), "cerebro-git-test-"));
  return { path: p, cleanup: () => rmSync(p, { recursive: true, force: true }) };
};

/** Init a throwaway git repo with an origin remote. */
const initGitRepo = (dir: string): void => {
  Bun.spawnSync(["git", "init"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "config", "user.name", "test"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  writeFileSync(join(dir, "readme.md"), "hello");
  Bun.spawnSync(["git", "add", "."], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "remote", "add", "origin", "https://github.com/user/repo.git"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
};

describe("gitInfo", () => {
  test("positive path: real git repo resolves to root and origin remote", () => {
    const { path, cleanup } = tempDir();
    try {
      initGitRepo(path);
      const info = gitInfo(path);
      expect(info.root).not.toBeNull();
      // Compare resolved paths to handle platform backslash/forward-slash differences
      expect(resolve(info.root!)).toBe(resolve(path));
      expect(info.remote).toBe("https://github.com/user/repo.git");
    } finally {
      cleanup();
    }
  });

  test("non-repo directory returns nulls", () => {
    const { path, cleanup } = tempDir();
    try {
      expect(gitInfo(path)).toEqual({ root: null, remote: null });
    } finally {
      cleanup();
    }
  });

  test("missing / non-existent directory returns nulls without throwing", () => {
    const missing = join(tmpdir(), "cerebro-git-nonexistent-" + Date.now());
    expect(gitInfo(missing)).toEqual({ root: null, remote: null });
  });

  test("falsy cwd returns nulls", () => {
    expect(gitInfo(null)).toEqual({ root: null, remote: null });
    expect(gitInfo(undefined)).toEqual({ root: null, remote: null });
    expect(gitInfo("")).toEqual({ root: null, remote: null });
  });

  test("distinct cwds avoid module-level cache bleed", () => {
    const d1 = tempDir();
    const d2 = tempDir();
    try {
      expect(gitInfo(d1.path)).toEqual({ root: null, remote: null });
      expect(gitInfo(d2.path)).toEqual({ root: null, remote: null });
    } finally {
      d1.cleanup();
      d2.cleanup();
    }
  });

  test("cached result is returned without re-running git", () => {
    const { path, cleanup } = tempDir();
    try {
      // Populate cache with non-repo result
      expect(gitInfo(path)).toEqual({ root: null, remote: null });
      // Init git at the same path after the cache is populated
      initGitRepo(path);
      // Should still return the cached (non-repo) result
      expect(gitInfo(path)).toEqual({ root: null, remote: null });
    } finally {
      cleanup();
    }
  });
});
