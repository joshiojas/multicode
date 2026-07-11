# 0003 — Git worktree isolation and diff-based verification

- Status: Accepted
- Date: 2026-07

## Context

Write-capable tasks run untrusted agent output that edits files. Two risks follow: the edits could
damage the user's working copy, and the agent's *description* of what it changed cannot be trusted.

## Decision

- **Isolation:** every write task runs in a dedicated, throwaway `git worktree` on its own branch,
  created from a pinned base commit under a single managed directory. The user's working copy is never
  touched. Worktrees are removed (with their branch) on terminal states; the manager refuses to operate
  on any path outside the managed directory.
- **Verification:** the task result is reconciled against the **real Git diff**. At turn end Multicode
  runs `git add -A` in the worktree and `git diff --cached <baseRef>` (rename detection off, for
  unambiguous add/modify/delete), records observed command exit codes from the event stream, stores the
  unified patch as a SHA-256-stamped artifact, and sets `changeConfirmed` only on objective evidence.

## Consequences

- **Positive:** the user's tree is safe; results are trustworthy and auditable; `multicode_get_diff`
  returns ground truth even after cleanup (from the stored patch).
- **Negative:** write tasks require a Git repository as the workspace root; worktree create/cleanup adds
  latency and disk.
- **Note:** interactive write sessions retain the worktree until finalized so follow-up turns operate on
  the same filesystem state.
