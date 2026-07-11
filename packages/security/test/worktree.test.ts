import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecurityError, asTaskId, type TaskId } from '@multicode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorktreeManager, git, gitText } from '@multicode/security';

const seedRepo = async (repo: string): Promise<void> => {
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.email', 'test@multicode.dev']);
  await git(repo, ['config', 'user.name', 'Multicode Test']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  writeFileSync(join(repo, 'keep.txt'), 'original\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'initial']);
};

describe('WorktreeManager (integration)', () => {
  let dir: string;
  let repo: string;
  let manager: WorktreeManager;
  const taskId: TaskId = asTaskId('task_wt_1');

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mc-wt-'));
    repo = join(dir, 'repo');
    mkdirSync(repo);
    await seedRepo(repo);
    manager = new WorktreeManager(join(dir, 'worktrees'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates an isolated worktree, computes a verified diff, and removes it', async () => {
    const handle = await manager.create({ repoRoot: repo, taskId });
    expect(existsSync(handle.path)).toBe(true);
    expect(handle.branch).toBe(`multicode/${taskId}`);

    // The main working tree is untouched by edits in the worktree.
    writeFileSync(join(handle.path, 'new-file.ts'), 'export const x = 1;\n');
    writeFileSync(join(handle.path, 'keep.txt'), 'modified\n');

    const { summary, patch } = await manager.diff(handle);
    expect(summary.baseRef).toBe(handle.baseRef);
    expect(summary.filesChanged).toBe(2);
    const byPath = Object.fromEntries(summary.files.map((f) => [f.path, f]));
    expect(byPath['new-file.ts']?.changeType).toBe('added');
    expect(byPath['keep.txt']?.changeType).toBe('modified');
    expect(summary.insertions).toBeGreaterThan(0);
    expect(patch).toContain('new-file.ts');
    expect(summary.patchSha256).toMatch(/^[0-9a-f]{64}$/);

    // The main repo's file is unchanged — isolation holds.
    expect((await gitText(repo, ['show', 'HEAD:keep.txt'])).trim()).toBe('original');

    await manager.remove(repo, handle);
    expect(existsSync(handle.path)).toBe(false);
    // Branch is cleaned up.
    const branches = await gitText(repo, ['branch', '--list', handle.branch]);
    expect(branches).toBe('');
  });

  it('refuses to operate on a worktree path outside the managed directory', async () => {
    const rogue = { path: join(dir, 'elsewhere'), branch: 'multicode/x', baseRef: 'HEAD' };
    await expect(manager.remove(repo, rogue)).rejects.toBeInstanceOf(SecurityError);
  });

  it('rejects write tasks against a non-git directory', async () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    await expect(manager.create({ repoRoot: plain, taskId: asTaskId('task_x') })).rejects.toThrow();
  });
});
