# @multicode/security

The enforcement layer that makes it safe to run untrusted coding-agent output in
[Multicode](https://github.com/joshiojas/multicode).

- **Path confinement** — `WorkspaceGuard` / `resolveWithinRoot`: rejects lexical traversal and
  symlink escapes; validated by property-based tests.
- **Worktree isolation** — `WorktreeManager`: throwaway `git worktree` per write task, safe cleanup.
- **Verification** — `computeDiff`: ground-truth Git diff (real add/modify/delete + patch SHA).
- **Bounded output** — `BoundedBuffer`.
- **Safe execution** — `runCommand`: timeout, cooperative-then-forced cancellation, byte-bounded I/O.
- **Policy resolution** — `resolveExecutionPolicy` / `assertPolicyEnforceable`: no silent privilege
  escalation; enforceability checked against provider capabilities.

See the [security model](https://github.com/joshiojas/multicode/blob/main/docs/security.md).

Licensed under Apache-2.0.
