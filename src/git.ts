export interface GitInfo {
  root: string | null;
  remote: string | null;
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
    if (!cwd) return { root: null, remote: null };

    const cached = cache.get(cwd);
    if (cached) return cached;

    const root = runGit(cwd, ["rev-parse", "--show-toplevel"]);
    const remote = root ? runGit(cwd, ["remote", "get-url", "origin"]) : null;
    const info: GitInfo = { root, remote };
    cache.set(cwd, info);
    return info;
  };
};
