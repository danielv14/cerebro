import type { Database } from "bun:sqlite";
import type { GitInfo } from "./git.ts";

// The remote is what a worktree shares with its main checkout, so it outranks any
// path. Without one the main worktree root stands in, and outside git the cwd.
export const repoKey = (git: GitInfo, cwd: string | null): string | null =>
  git.remote ?? git.mainRoot ?? cwd;

export const repoName = (key: string): string =>
  key
    .replace(/\/*(\.git)?\/*$/, "")
    .split(/[/:]/)
    .pop() || key;

// Rows with no key yet (pre-v9, an older build, a directory gone at index time) start
// from their stored columns. Then the newest remote recorded at a git_root claims every
// row there and every row keyed on that root, so a thread recorded before the remote
// was added, in a worktree too, stays in its repo. See docs/architecture.md.
export const settleRepoKeys = (db: Database): void => {
  db.run(
    "UPDATE sessions SET repo_key = COALESCE(git_remote, git_root, cwd) WHERE repo_key IS NULL",
  );
  for (const column of ["git_root", "repo_key"]) {
    db.run(
      `UPDATE sessions SET repo_key = newest.git_remote
       FROM (SELECT git_root, git_remote, MAX(last_ts) FROM sessions
             WHERE git_remote IS NOT NULL GROUP BY git_root) newest
       WHERE sessions.${column} = newest.git_root AND sessions.repo_key IS NOT newest.git_remote`,
    );
  }
};
