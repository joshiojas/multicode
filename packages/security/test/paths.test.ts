import { mkdtempSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecurityError, WorkspaceError } from '@multicode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceGuard, isWithinRoot, resolveWithinRoot } from '@multicode/security';

describe('isWithinRoot', () => {
  it('handles prefix confusion (/repo vs /repo-evil)', () => {
    expect(isWithinRoot('/repo', '/repo/src')).toBe(true);
    expect(isWithinRoot('/repo', '/repo')).toBe(true);
    expect(isWithinRoot('/repo', '/repo-evil')).toBe(false);
    expect(isWithinRoot('/repo', '/repo-evil/x')).toBe(false);
  });

  it('rejects parent traversal', () => {
    expect(isWithinRoot('/repo/sub', '/repo')).toBe(false);
    expect(isWithinRoot('/repo', '/etc/passwd')).toBe(false);
  });
});

describe('resolveWithinRoot', () => {
  it('rejects null bytes', () => {
    expect(() => resolveWithinRoot('/repo', 'a\0b')).toThrow(SecurityError);
  });

  it('rejects absolute escapes and traversal', () => {
    expect(() => resolveWithinRoot('/repo', '/etc/passwd')).toThrow(SecurityError);
    expect(() => resolveWithinRoot('/repo', '../secrets')).toThrow(SecurityError);
  });

  it('allows descendants', () => {
    expect(resolveWithinRoot('/repo', 'src/app.ts')).toBe('/repo/src/app.ts');
  });
});

describe('symlink escape defense', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mc-sym-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a path that escapes via a symlinked directory', () => {
    const root = join(dir, 'root');
    const outside = join(dir, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
    // root/link -> ../outside
    symlinkSync(outside, join(root, 'link'));

    // Lexically "root/link/secret.txt" looks contained, but realpath escapes → must be rejected.
    expect(() => resolveWithinRoot(root, 'link/secret.txt')).toThrow(SecurityError);
  });

  it('allows a symlink that stays within the root', () => {
    const root = join(dir, 'root');
    mkdirSync(join(root, 'real'), { recursive: true });
    writeFileSync(join(root, 'real', 'ok.txt'), 'fine');
    symlinkSync(join(root, 'real'), join(root, 'alias'));
    expect(() => resolveWithinRoot(root, 'alias/ok.txt')).not.toThrow();
  });
});

describe('WorkspaceGuard', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mc-guard-'));
    mkdirSync(join(dir, 'allowed'), { recursive: true });
    mkdirSync(join(dir, 'other'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('accepts an approved root and its descendants', () => {
    const guard = WorkspaceGuard.fromRoots([join(dir, 'allowed')]);
    mkdirSync(join(dir, 'allowed', 'pkg'));
    expect(guard.resolveRoot(join(dir, 'allowed', 'pkg'))).toContain('allowed');
  });

  it('rejects a root outside every approved root', () => {
    const guard = WorkspaceGuard.fromRoots([join(dir, 'allowed')]);
    expect(() => guard.resolveRoot(join(dir, 'other'))).toThrow(WorkspaceError);
  });

  it('refuses to run when no roots are configured', () => {
    const guard = WorkspaceGuard.fromRoots([]);
    expect(() => guard.resolveRoot(dir)).toThrow(WorkspaceError);
  });

  it('isSafe never throws', () => {
    const guard = WorkspaceGuard.fromRoots([join(dir, 'allowed')]);
    const root = guard.resolveRoot(join(dir, 'allowed'));
    expect(guard.isSafe(root, 'src/x.ts')).toBe(true);
    expect(guard.isSafe(root, '../../etc/passwd')).toBe(false);
  });
});
