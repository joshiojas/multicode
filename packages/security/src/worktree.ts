import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SecurityError, WorkspaceError, type DiffSummary, type TaskId } from '@multicode/core';
import { computeDiff, git, hasCommits, headCommit, isGitRepo } from './git.js';
import { isWithinRoot } from './paths.js';

export interface WorktreeHandle {
  /** Absolute path of the isolated worktree. */
  readonly path: string;
  /** Branch created for the worktree. */
  readonly branch: string;
  /** Commit the worktree was created from (the diff base). */
  readonly baseRef: string;
}

export interface CreateWorktreeInput {
  /** Absolute, validated repository root (a Git work tree). */
  readonly repoRoot: string;
  readonly taskId: TaskId;
  /** Base ref to branch from; defaults to the repo's current HEAD. */
  readonly baseRef?: string;
}

/**
 * Manages the lifecycle of isolated Git worktrees for write tasks. Every worktree lives under a single
 * managed directory (`<dataDir>/worktrees`); the manager refuses to create or remove anything outside
 * that directory, so a bug or a malicious ref can never make it operate on an arbitrary path.
 */
export class WorktreeManager {
  readonly #baseDir: string;

  constructor(baseDir: string) {
    this.#baseDir = resolve(baseDir);
  }

  get baseDir(): string {
    return this.#baseDir;
  }

  /** Create an isolated worktree branched from `baseRef` (or HEAD). */
  async create(input: CreateWorktreeInput): Promise<WorktreeHandle> {
    const { repoRoot, taskId } = input;

    if (!(await isGitRepo(repoRoot))) {
      throw new WorkspaceError('Write tasks require a Git repository as the workspace root', {
        details: { repoRoot },
      });
    }
    if (!(await hasCommits(repoRoot))) {
      throw new WorkspaceError('Repository has no commits to branch a worktree from', {
        details: { repoRoot },
      });
    }

    const baseRef = input.baseRef ?? (await headCommit(repoRoot));
    const path = join(this.#baseDir, taskId);
    this.#assertManaged(path);

    if (existsSync(path)) {
      throw new SecurityError('Worktree path already exists; refusing to overwrite', {
        details: { path },
      });
    }

    await mkdir(this.#baseDir, { recursive: true });
    const branch = `multicode/${taskId}`;
    const result = await git(repoRoot, ['worktree', 'add', '-b', branch, path, baseRef]);
    if (result.exitCode !== 0) {
      throw new WorkspaceError(`Failed to create worktree (git exit ${result.exitCode})`, {
        details: { stderr: result.stderr.slice(0, 2000), path, branch, baseRef },
      });
    }
    return { path, branch, baseRef };
  }

  /** Compute the verified diff of a worktree against its base ref. */
  async diff(handle: WorktreeHandle, opts?: { maxPatchBytes?: number }): Promise<{ summary: DiffSummary; patch: string }> {
    this.#assertManaged(handle.path);
    return computeDiff(handle.path, handle.baseRef, opts ?? {});
  }

  /**
   * Remove a worktree and its branch. Uses `git worktree remove --force` (which safely refuses paths it
   * does not own) and additionally asserts the path is inside the managed directory before touching it.
   */
  async remove(repoRoot: string, handle: WorktreeHandle): Promise<void> {
    this.#assertManaged(handle.path);
    // `git worktree remove` is the safe path — it validates the target is a registered worktree.
    await git(repoRoot, ['worktree', 'remove', '--force', handle.path]);
    await git(repoRoot, ['worktree', 'prune']);
    // Best-effort branch cleanup; ignore failure (branch may already be gone).
    await git(repoRoot, ['branch', '-D', handle.branch]);
  }

  /** Guard: the path must be inside the managed worktrees directory. */
  #assertManaged(path: string): void {
    if (!isWithinRoot(this.#baseDir, path)) {
      throw new SecurityError('Refusing to operate on a worktree outside the managed directory', {
        details: { path, baseDir: this.#baseDir },
      });
    }
  }
}
