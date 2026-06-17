export interface GitInfo {
  root: string | null;
  remote: string | null;
}

const cache = new Map<string, GitInfo>();

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

// Resolve git root + origin remote for a cwd. Tolerates a missing/moved/deleted
// directory by returning nulls instead of throwing. Cached per cwd.
export const gitInfo = (cwd: string | null | undefined): GitInfo => {
  if (!cwd) return { root: null, remote: null };

  const cached = cache.get(cwd);
  if (cached) return cached;

  const root = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const remote = root ? runGit(cwd, ["remote", "get-url", "origin"]) : null;
  const info: GitInfo = { root, remote };
  cache.set(cwd, info);
  return info;
};
