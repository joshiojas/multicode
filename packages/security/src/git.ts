import { createHash } from 'node:crypto';
import { ProviderError, type DiffSummary, type FileChange, type FileChangeType } from '@multicode/core';
import { runCommand, type RunCommandResult } from './exec.js';

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_OUTPUT = 64 * 1024 * 1024;

export interface GitOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/** Run a `git` subcommand in `cwd`. Returns the raw result (exit code included). */
export const git = (
  cwd: string,
  args: readonly string[],
  opts: GitOptions = {},
): Promise<RunCommandResult> =>
  runCommand('git', args, {
    cwd,
    // Git needs a minimal environment; pass through PATH and HOME so it can find itself and config.
    env: opts.env ?? minimalGitEnv(),
    timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT_MS,
    maxOutputBytes: opts.maxOutputBytes ?? GIT_MAX_OUTPUT,
  });

/** Run a `git` subcommand and return trimmed stdout, throwing on a non-zero exit. */
export const gitText = async (
  cwd: string,
  args: readonly string[],
  opts?: GitOptions,
): Promise<string> => {
  const result = await git(cwd, args, opts);
  if (result.exitCode !== 0) {
    throw new ProviderError(`git ${args.join(' ')} failed (exit ${result.exitCode})`, {
      details: { stderr: result.stderr.slice(0, 2000) },
    });
  }
  return result.stdout.trim();
};

const minimalGitEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'GIT_EXEC_PATH', 'APPDATA']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Deterministic, non-interactive git.
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_OPTIONAL_LOCKS'] = '0';
  return env;
};

/** Whether `dir` is inside a Git working tree. */
export const isGitRepo = async (dir: string): Promise<boolean> => {
  const result = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  return result.exitCode === 0 && result.stdout.trim() === 'true';
};

/** The current HEAD commit SHA of `dir`. */
export const headCommit = (dir: string): Promise<string> =>
  gitText(dir, ['rev-parse', 'HEAD']);

/** Whether the repo has at least one commit (needed as a diff base). */
export const hasCommits = async (dir: string): Promise<boolean> => {
  const result = await git(dir, ['rev-parse', '--verify', 'HEAD']);
  return result.exitCode === 0;
};

const CHANGE_TYPE: Record<string, FileChangeType> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  T: 'type_changed',
  C: 'added',
};

/**
 * Compute the ground-truth diff of a worktree against `baseRef`. Rename detection is disabled so every
 * change is an unambiguous add/modify/delete — the point is a trustworthy account of what changed, not
 * a pretty diff. Untracked files are included by staging everything first (the worktree is a managed,
 * throwaway checkout, so mutating its index is safe).
 *
 * Returns both the structured {@link DiffSummary} and the full unified patch text.
 */
export const computeDiff = async (
  worktreePath: string,
  baseRef: string,
  opts: { maxPatchBytes?: number } = {},
): Promise<{ summary: DiffSummary; patch: string }> => {
  // Stage all working-tree changes (adds, mods, deletes) so the diff captures untracked files too.
  await git(worktreePath, ['add', '-A']);

  const numstat = await gitText(worktreePath, [
    'diff',
    '--cached',
    '--no-renames',
    '--numstat',
    baseRef,
  ]);
  const nameStatus = await gitText(worktreePath, [
    'diff',
    '--cached',
    '--no-renames',
    '--name-status',
    baseRef,
  ]);
  const patchResult = await git(worktreePath, ['diff', '--cached', '--no-renames', baseRef], {
    maxOutputBytes: opts.maxPatchBytes ?? GIT_MAX_OUTPUT,
  });
  const patch = patchResult.stdout;

  const counts = parseNumstat(numstat);
  const files = parseNameStatus(nameStatus, counts);

  const insertions = files.reduce((s, f) => s + f.insertions, 0);
  const deletions = files.reduce((s, f) => s + f.deletions, 0);

  const summary: DiffSummary = {
    filesChanged: files.length,
    insertions,
    deletions,
    files,
    baseRef,
    patchSha256: patch.length > 0 ? sha256(patch) : undefined,
    truncated: patchResult.stdoutTruncated,
  };
  return { summary, patch };
};

interface Counts {
  insertions: number;
  deletions: number;
  binary: boolean;
}

const parseNumstat = (text: string): Map<string, Counts> => {
  const map = new Map<string, Counts>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [ins, del, ...rest] = parts;
    const path = rest.join('\t');
    const binary = ins === '-' || del === '-';
    map.set(path, {
      insertions: binary ? 0 : Number.parseInt(ins ?? '0', 10) || 0,
      deletions: binary ? 0 : Number.parseInt(del ?? '0', 10) || 0,
      binary,
    });
  }
  return map;
};

const parseNameStatus = (text: string, counts: Map<string, Counts>): FileChange[] => {
  const files: FileChange[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    const statusToken = parts[0] ?? '';
    const path = parts.slice(1).join('\t');
    if (path === '') continue;
    const letter = statusToken.charAt(0).toUpperCase();
    const changeType = CHANGE_TYPE[letter] ?? 'modified';
    const c = counts.get(path);
    files.push({
      path,
      changeType,
      insertions: c?.insertions ?? 0,
      deletions: c?.deletions ?? 0,
      binary: c?.binary ?? false,
    });
  }
  return files;
};

export const sha256 = (data: string): string =>
  createHash('sha256').update(data, 'utf8').digest('hex');
