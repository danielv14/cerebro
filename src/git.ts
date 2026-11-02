export interface GitInfo {
  root: string | null;
  remote: string | null;
  mainRoot: string | null;
}

export type GitResolver = (cwd: string | null | undefined) => GitInfo;

const runGit = (cwd: string, args: string[]): string | null => {
  try {
    const proc = Bun.spawnSync(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode !== 0) return null;
    const out = proc.stdout.toString().trim();
    return out || null;
  } catch {
    return null;
  }
};

export const createGitResolver = (): GitResolver => {
  const cache = new Map<string, GitInfo>();
  return (cwd) => {
    if (!cwd) return { root: null, remote: null, mainRoot: null };

    const cached = cache.get(cwd);
    if (cached) return cached;

    const [root = null, commonDir = null] =
      runGit(cwd, [
        "rev-parse",
        "--show-toplevel",
        "--path-format=absolute",
        "--git-common-dir",
      ])?.split("\n") ?? [];
    const remote = root ? runGit(cwd, ["remote", "get-url", "origin"]) : null;
    // Every worktree shares the main checkout's .git, so its parent is the repo's
    // one root; a bare repo's common dir is the repo itself.
    const mainRoot = commonDir?.replace(/\/\.git$/, "") ?? root;
    const info: GitInfo = { root, remote, mainRoot };
    cache.set(cwd, info);
    return info;
  };
};
