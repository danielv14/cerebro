import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitInfo } from "../src/git.ts";

// git.ts was the last source module with no test. Its positive path (a real repo
// resolving to its root + origin remote) populates the git_root that `recent` scopes
// by, and invariant #8 requires it to tolerate a missing directory by returning
// nulls rather than throwing (it runs for every top-level session inside the
// per-file index transaction). These drive the real `git` over throwaway dirs; each
// case uses a distinct cwd so the module-level cache does not bleed between cases.
describe("gitInfo", () => {
  const made: string[] = [];

  const tempDir = (): string => {
    const dir = fs.mkdtempSync(join(tmpdir(), "cerebro-git-"));
    made.push(dir);
    return dir;
  };

  const git = (cwd: string, args: string[]): void => {
    Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
  };

  afterEach(() => {
    while (made.length) fs.rmSync(made.pop()!, { recursive: true, force: true });
  });

  test("resolves the root and origin remote of a real repo", () => {
    const repo = tempDir();
    git(repo, ["init"]);
    git(repo, ["remote", "add", "origin", "https://example.com/foo.git"]);

    const info = gitInfo(repo);
    // git rev-parse --show-toplevel returns the canonical (symlink-resolved) path;
    // on macOS the temp dir is under a /private symlink, so compare to realpath.
    expect(info.root).toBe(fs.realpathSync(repo));
    expect(info.remote).toBe("https://example.com/foo.git");
  });

  test("a repo with no origin remote resolves the root but a null remote", () => {
    const repo = tempDir();
    git(repo, ["init"]);

    const info = gitInfo(repo);
    expect(info.root).toBe(fs.realpathSync(repo));
    expect(info.remote).toBeNull();
  });

  test("caches per cwd: a second call returns the identical object", () => {
    const repo = tempDir();
    git(repo, ["init"]);

    const first = gitInfo(repo);
    const second = gitInfo(repo);
    expect(second).toBe(first); // same reference, served from the per-cwd cache
  });

  test("a non-repo directory resolves to nulls", () => {
    const dir = tempDir(); // created but never `git init`-ed
    expect(gitInfo(dir)).toEqual({ root: null, remote: null });
  });

  test("a missing directory resolves to nulls without throwing (invariant #8)", () => {
    const missing = join(tmpdir(), "cerebro-git-does-not-exist-zzz");
    expect(() => gitInfo(missing)).not.toThrow();
    expect(gitInfo(missing)).toEqual({ root: null, remote: null });
  });

  test("a falsy cwd resolves to nulls without spawning git", () => {
    expect(gitInfo(null)).toEqual({ root: null, remote: null });
    expect(gitInfo(undefined)).toEqual({ root: null, remote: null });
    expect(gitInfo("")).toEqual({ root: null, remote: null });
  });
});
