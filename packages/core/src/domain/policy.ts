import { z } from 'zod';

/**
 * Whether a task may modify files. `read_only` tasks run against the workspace with no write access;
 * `write` tasks run in an isolated Git worktree.
 */
export const TaskMode = z.enum(['read_only', 'write']);
export type TaskMode = z.infer<typeof TaskMode>;

/**
 * Sandbox strength requested for a task. Providers advertise which levels they support; the
 * orchestrator negotiates the effective level (never weaker than requested without an explicit
 * downgrade acknowledgement).
 *
 * - `danger_full_access` — no sandbox (requires explicit opt-in; strongly discouraged).
 * - `workspace_write` — writes confined to the task worktree; reads broader.
 * - `read_only` — no writes anywhere.
 */
export const SandboxLevel = z.enum(['read_only', 'workspace_write', 'danger_full_access']);
export type SandboxLevel = z.infer<typeof SandboxLevel>;

/** Network access policy for a task's execution environment. */
export const NetworkPolicy = z.enum(['disabled', 'restricted', 'enabled']);
export type NetworkPolicy = z.infer<typeof NetworkPolicy>;

/**
 * How provider approval requests are handled.
 * - `never` — auto-deny anything requiring elevation (safest; some tasks will be blocked).
 * - `on_request` — surface every request to the MCP client as an approval and wait.
 * - `on_failure` — only prompt when a sandboxed action fails and elevation would unblock it.
 * - `auto` — auto-approve within policy (requires explicit, audited opt-in).
 */
export const ApprovalPolicy = z.enum(['never', 'on_request', 'on_failure', 'auto']);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

/** Bounds applied to every task regardless of provider. */
export const ExecutionLimits = z
  .object({
    /** Wall-clock timeout for a single turn, in milliseconds. */
    timeoutMs: z.number().int().positive().max(24 * 60 * 60 * 1000),
    /** Grace period between cooperative cancel and hard kill, in milliseconds. */
    cancelGraceMs: z.number().int().nonnegative().max(5 * 60 * 1000),
    /** Maximum bytes of provider/command output retained per task before truncation. */
    maxOutputBytes: z.number().int().positive().max(512 * 1024 * 1024),
    /** Maximum number of events persisted per task (older streamed chunks are compacted). */
    maxEvents: z.number().int().positive().max(5_000_000),
  })
  .strict();
export type ExecutionLimits = z.infer<typeof ExecutionLimits>;

/**
 * The complete, resolved execution policy for a task. This is the security-relevant contract handed
 * to the runtime; it is persisted with the task so recovery and audit see exactly what was allowed.
 */
export const ExecutionPolicy = z
  .object({
    mode: TaskMode,
    sandbox: SandboxLevel,
    network: NetworkPolicy,
    approvals: ApprovalPolicy,
    limits: ExecutionLimits,
    /** Additional absolute paths the task may read outside the workspace root (allow-list). */
    extraReadRoots: z.array(z.string()).default([]),
    /** Environment variable names to pass through to the runtime (values resolved at spawn time). */
    passthroughEnv: z.array(z.string()).default([]),
  })
  .strict();
export type ExecutionPolicy = z.infer<typeof ExecutionPolicy>;

export const DEFAULT_LIMITS: ExecutionLimits = {
  timeoutMs: 30 * 60 * 1000,
  cancelGraceMs: 10 * 1000,
  maxOutputBytes: 32 * 1024 * 1024,
  maxEvents: 250_000,
};

/**
 * The safe default policy: read-only, sandboxed, no network, prompt on every elevation request.
 * A write task must explicitly widen `mode` and `sandbox`.
 */
export const DEFAULT_POLICY: ExecutionPolicy = {
  mode: 'read_only',
  sandbox: 'read_only',
  network: 'disabled',
  approvals: 'on_request',
  limits: DEFAULT_LIMITS,
  extraReadRoots: [],
  passthroughEnv: [],
};

/**
 * Rank sandbox levels so the orchestrator can compare "requested" vs "effective" and refuse silent
 * downgrades. Higher number = more permissive.
 */
export const sandboxRank = (level: SandboxLevel): number => {
  switch (level) {
    case 'read_only':
      return 0;
    case 'workspace_write':
      return 1;
    case 'danger_full_access':
      return 2;
  }
};

/** True if `mode` requires an isolated worktree (any write task). */
export const requiresWorktree = (mode: TaskMode): boolean => mode === 'write';
