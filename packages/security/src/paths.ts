import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { SecurityError, WorkspaceError } from '@multicode/core';

/**
 * Path confinement — the security spine of Multicode. Every filesystem location a task might touch is
 * funneled through here and proven to live inside an approved root. Two attack classes are defended:
 *
 *  1. **Lexical traversal** (`..`, absolute paths, prefix confusion like `/repo` vs `/repo-evil`) is
 *     rejected by comparing with `path.relative`, never by string `startsWith`.
 *  2. **Symlink escape** — an existing component that is a symlink pointing outside the root — is
 *     rejected by resolving the deepest existing ancestor with `realpath` and re-checking containment.
 */

/** Reject strings that can smuggle null bytes past later filesystem calls. */
const assertNoNullByte = (value: string): void => {
  if (value.includes('\0')) {
    throw new SecurityError('Path contains a null byte', { details: { value: '<redacted>' } });
  }
};

/**
 * Pure lexical containment: is `target` equal to, or a descendant of, `root`? Both are resolved to
 * absolute first. Uses `path.relative` so `/repo` does not "contain" `/repo-evil`.
 */
export const isWithinRoot = (root: string, target: string): boolean => {
  const absRoot = resolve(root);
  const absTarget = resolve(target);
  if (absRoot === absTarget) return true;
  const rel = relative(absRoot, absTarget);
  return rel.length > 0 && !rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Throw {@link SecurityError} unless `target` is contained in `root`. */
export const assertWithinRoot = (root: string, target: string, label = 'path'): void => {
  if (!isWithinRoot(root, target)) {
    throw new SecurityError(`Rejected ${label} outside the workspace root`, {
      details: { root: resolve(root), target: resolve(target) },
    });
  }
};

/**
 * Resolve the deepest existing ancestor of `absTarget` with `realpath`, then re-attach the
 * not-yet-existing tail. This exposes a symlinked directory in the middle of the path.
 */
const resolveThroughSymlinks = (absTarget: string): string => {
  let existing = absTarget;
  const tail: string[] = [];
  // Walk up until we hit a path that exists on disk.
  while (!existsSync(existing)) {
    const parent = resolve(existing, '..');
    if (parent === existing) break; // reached filesystem root
    const rel = relative(parent, existing);
    tail.unshift(rel);
    existing = parent;
  }
  const realExisting = existsSync(existing) ? realpathSync(existing) : existing;
  return tail.length > 0 ? resolve(realExisting, ...tail) : realExisting;
};

/**
 * Resolve `candidate` (relative to `root`, or absolute) into an absolute path proven to be confined to
 * `root` — both lexically and after symlink resolution. Throws {@link SecurityError} on any escape.
 *
 * `root` is assumed to already be a validated, realpath-resolved workspace root (see
 * {@link WorkspaceGuard}). When it is not, pass the raw root and it will still be resolved, but callers
 * should prefer validating roots once up front.
 */
export const resolveWithinRoot = (root: string, candidate: string): string => {
  assertNoNullByte(root);
  assertNoNullByte(candidate);

  const absRoot = resolve(root);
  // Absolute candidates override `root`; relative ones are joined onto it. Either way we confine.
  const absCandidate = isAbsolute(candidate) ? resolve(candidate) : resolve(absRoot, candidate);

  assertWithinRoot(absRoot, absCandidate);

  const realRoot = existsSync(absRoot) ? realpathSync(absRoot) : absRoot;
  const realCandidate = resolveThroughSymlinks(absCandidate);
  if (!isWithinRoot(realRoot, realCandidate)) {
    throw new SecurityError('Rejected path that escapes the workspace root via a symlink', {
      details: { realRoot, realCandidate },
    });
  }
  return absCandidate;
};

/**
 * A validated set of workspace roots. Construct once from configuration; every task path check goes
 * through {@link resolveRoot} and {@link resolvePath}.
 */
export class WorkspaceGuard {
  /** Realpath-resolved allowed roots. */
  readonly #roots: readonly string[];

  private constructor(roots: readonly string[]) {
    this.#roots = roots;
  }

  /** Build a guard from configured roots, resolving each to an absolute realpath. */
  static fromRoots(roots: readonly string[]): WorkspaceGuard {
    const resolved = roots.map((r) => {
      assertNoNullByte(r);
      const abs = resolve(r);
      return existsSync(abs) ? realpathSync(abs) : abs;
    });
    return new WorkspaceGuard(resolved);
  }

  /** The configured roots (realpath-resolved), for diagnostics. */
  get roots(): readonly string[] {
    return this.#roots;
  }

  /**
   * Validate a requested workspace root: it must resolve to one of the configured roots, or a
   * descendant of one. Returns the validated absolute (realpath-resolved) root.
   */
  resolveRoot(requested: string): string {
    assertNoNullByte(requested);
    if (this.#roots.length === 0) {
      throw new WorkspaceError('No workspace roots are configured; refusing to run any task', {
        details: { requested },
      });
    }
    const abs = resolve(requested);
    const real = existsSync(abs) ? realpathSync(abs) : abs;
    const match = this.#roots.find((root) => isWithinRoot(root, real));
    if (!match) {
      throw new WorkspaceError('Requested workspace root is not within any approved root', {
        details: { requested: real, approved: this.#roots },
      });
    }
    return real;
  }

  /**
   * Resolve a task-relative path within a previously-validated root. Combines lexical and symlink
   * confinement.
   */
  resolvePath(validatedRoot: string, candidate: string): string {
    return resolveWithinRoot(validatedRoot, candidate);
  }

  /** Boolean form of {@link resolvePath} that never throws. */
  isSafe(validatedRoot: string, candidate: string): boolean {
    try {
      this.resolvePath(validatedRoot, candidate);
      return true;
    } catch {
      return false;
    }
  }
}
