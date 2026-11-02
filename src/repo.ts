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

// Keeps a thread recorded before its repo's remote was added (or renamed) in that
// repo, and keys rows an older build wrote without one. See docs/architecture.md.
export const settleRepoKeys = (db: Database): void => {
  db.run(
    `UPDATE sessions SET repo_key = newest.git_remote
     FROM (SELECT git_root, git_remote, MAX(last_ts) FROM sessions
           WHERE git_remote IS NOT NULL GROUP BY git_root) newest
     WHERE sessions.git_root = newest.git_root AND sessions.repo_key IS NOT newest.git_remote`,
  );
  db.run("UPDATE sessions SET repo_key = COALESCE(git_root, cwd) WHERE repo_key IS NULL");
};
