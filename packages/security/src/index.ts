/**
 * `@multicode/security` — the enforcement layer that makes it safe to run untrusted coding-agent
 * output: workspace-root confinement, path-traversal and symlink-escape protection, isolated Git
 * worktrees, verified diffs, bounded output, safe process execution, and policy resolution that never
 * silently escalates privilege.
 */
export {
  WorkspaceGuard,
  isWithinRoot,
  assertWithinRoot,
  resolveWithinRoot,
} from './paths.js';

export { BoundedBuffer } from './output.js';
export { runCommand, type RunCommandOptions, type RunCommandResult } from './exec.js';
export {
  git,
  gitText,
  isGitRepo,
  headCommit,
  hasCommits,
  computeDiff,
  sha256,
  type GitOptions,
} from './git.js';
export {
  WorktreeManager,
  type WorktreeHandle,
  type CreateWorktreeInput,
} from './worktree.js';
export {
  resolveExecutionPolicy,
  assertPolicyEnforceable,
  type ResolvePolicyInput,
} from './policy-resolver.js';
