# Multicode Security Model

Multicode executes the output of an external coding agent against your source tree. That is inherently
dangerous, so the security posture is a first-class part of the design, not an afterthought. This
document describes the threat model, the trust boundaries, and the specific invariants Multicode
enforces.

## Threat model

The **agent (and its provider) are untrusted**. We assume a provider may, whether through a bug, a
prompt injection, or malice:

- try to read or write files outside the intended workspace (via `..`, absolute paths, or symlinks);
- try to run commands that escalate privilege, exfiltrate data, or use the network;
- run forever, or emit unbounded output;
- misreport what it did.

The **MCP client and the operator are trusted** — they choose the workspace roots and policies. The
**local machine** is the trust anchor: config and the SQLite database are protected by filesystem
permissions, same as any local dev tool.

Out of scope: vulnerabilities inside a provider CLI or its App Server (report upstream), and
deliberately over-broad configuration (an operator who grants `/` as a workspace root).

## Trust boundaries

```
   operator / MCP client  ──trusted──▶  Multicode  ──UNTRUSTED──▶  provider adapter ─▶ agent
        (chooses roots,                (enforces               (App Server child process,
         policies, approvals)           confinement)            sandboxed, cancellable)
```

Everything crossing the right-hand boundary is confined, bounded, and verified.

## Invariants

### 1. Workspace-root confinement

Every filesystem location a task may touch is resolved through `@multicode/security`'s path guards and
proven to live inside an approved root. Two attack classes are defended:

- **Lexical traversal** — `..`, absolute injection, and prefix confusion (`/repo` vs `/repo-evil`) are
  rejected using `path.relative`, never string `startsWith`.
- **Symlink escape** — the deepest existing ancestor is resolved with `realpath` and containment is
  re-checked, so a symlinked directory pointing outside the root is rejected even when the lexical path
  looks contained.

These invariants are exercised by **property-based tests** (`fast-check`) on every CI run, at elevated
iteration counts on a dedicated CI leg. The core property: *`resolveWithinRoot` never returns a path
outside the root — it either returns a contained path or throws.*

### 2. Worktree isolation

Write-capable tasks never touch your working copy. Each gets a throwaway `git worktree` on a dedicated
branch, created from a pinned base commit under a single managed directory
(`<dataDir>/worktrees`). The worktree manager refuses to create or remove anything outside that
directory, and cleans up (worktree + branch) when the task reaches a terminal state.

### 3. No silent privilege escalation

The effective execution policy is resolved from configured defaults plus task overrides with hard
rules (`resolveExecutionPolicy`):

- a `write` task requires at least a `workspace_write` sandbox — a contradictory `read_only` request is
  **rejected**, never silently escalated;
- the resolved policy is asserted **enforceable** by the chosen provider (`assertPolicyEnforceable`): a
  provider that cannot control the network may not be given a task that requires the network disabled;
  a provider that cannot enforce the requested sandbox level is refused.

### 4. Approvals gate elevation

Nothing elevated happens silently. Under `on_request`/`on_failure`, every provider request for an
elevated action becomes a durable, pending approval that blocks the task until an operator decides.
`never` auto-denies; `auto` is an explicit, audited opt-in.

### 5. Bounded execution

- **Timeouts:** every turn has a wall-clock timeout; on expiry the process is sent `SIGTERM`, then
  `SIGKILL` after a grace period.
- **Cancellation:** cooperative cancel via an `AbortSignal`, then forced.
- **Bounded output:** stdout/stderr and captured provider output are byte-capped; overflow is
  truncated and marked, so a runaway process cannot exhaust memory.

### 6. Verification, not trust

Task results are reconciled against real Git diffs and observed command exit codes. `changeConfirmed`
reflects objective evidence, and the unified patch is stored as a SHA-256-stamped artifact.

### 7. Credentials are never handled by Multicode

Each provider authenticates through its own supported local login flow (`multicode provider login`
shells out to, e.g., `codex login`). Multicode reads auth **status** only — for Codex it checks that
`~/.codex/auth.json` exists **without ever opening it**. Subscription tokens are never copied,
displayed, logged, or persisted by Multicode.

## Transport hardening

- **stdio (default):** the JSON-RPC stream owns stdout; all logs go to stderr or a file.
- **Streamable HTTP (optional):** binds to loopback by default; a bearer token is **required** for any
  non-loopback bind (enforced by config validation); DNS-rebinding protection (`allowedHosts` /
  `allowedOrigins`) is always on; requests are stateless (durable state is in the store).

## Reporting

See [`../SECURITY.md`](../SECURITY.md) for how to report a vulnerability.
