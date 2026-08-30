import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitResolver } from "../src/git.ts";

// The resolver's positive path (a real repo resolving to its root + origin remote)
// populates the git_root that `recent` scopes by, and invariant #9 requires it to
// tolerate a missing directory by returning nulls rather than throwing (it runs
// for every top-level session inside the per-file index transaction). These drive
// the real `git` over throwaway dirs; the cache is per instance, so each case makes
// its own resolver rather than needing a distinct cwd.
describe("createGitResolver", () => {
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

    const info = createGitResolver()(repo);
    // git rev-parse --show-toplevel returns the canonical (symlink-resolved) path;
    // on macOS the temp dir is under a /private symlink, so compare to realpath.
    expect(info.root).toBe(fs.realpathSync(repo));
    expect(info.remote).toBe("https://example.com/foo.git");
  });

  test("a repo with no origin remote resolves the root but a null remote", () => {
    const repo = tempDir();
    git(repo, ["init"]);

    const info = createGitResolver()(repo);
    expect(info.root).toBe(fs.realpathSync(repo));
    expect(info.remote).toBeNull();
  });

  test("caches per cwd: a second call on one resolver returns the identical object", () => {
    const repo = tempDir();
    git(repo, ["init"]);

    const resolveGit = createGitResolver();
    const first = resolveGit(repo);
    expect(resolveGit(repo)).toBe(first); // same reference, served from the per-cwd cache
  });

  test("the cache is per instance: a fresh resolver re-resolves the same cwd", () => {
    // What makes the seam testable: nothing a resolver saw leaks into the next one.
    const repo = tempDir();
    git(repo, ["init"]);

    const first = createGitResolver()(repo);
    const second = createGitResolver()(repo);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  test("a non-repo directory resolves to nulls", () => {
    const dir = tempDir(); // created but never `git init`-ed
    expect(createGitResolver()(dir)).toEqual({ root: null, remote: null });
  });

  test("a missing directory resolves to nulls without throwing (invariant #9)", () => {
    const missing = join(tmpdir(), "cerebro-git-does-not-exist-zzz");
    const resolveGit = createGitResolver();
    expect(() => resolveGit(missing)).not.toThrow();
    expect(resolveGit(missing)).toEqual({ root: null, remote: null });
  });

  test("a falsy cwd resolves to nulls without spawning git", () => {
    const resolveGit = createGitResolver();
    expect(resolveGit(null)).toEqual({ root: null, remote: null });
    expect(resolveGit(undefined)).toEqual({ root: null, remote: null });
    expect(resolveGit("")).toEqual({ root: null, remote: null });
  });
});
