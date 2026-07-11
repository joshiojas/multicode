import { z } from 'zod';
import { ExecutionPolicy, TaskMode } from './policy.js';
import { TaskResult } from './result.js';
import { TASK_STATUSES } from './status.js';

export const TaskStatusSchema = z.enum(TASK_STATUSES);

/**
 * How a task is bound to a place on disk. Read-only tasks operate directly in `root`; write tasks get
 * an isolated `worktreePath` created from `baseRef`. All of these paths are validated to live under an
 * approved workspace root before anything runs.
 */
export const WorkspaceBinding = z
  .object({
    /** Absolute, validated workspace root the task is confined to. */
    root: z.string(),
    /** Optional sub-directory within `root` the task should focus on (relative, no traversal). */
    subdir: z.string().optional(),
    /** Whether `root` is a Git repository (required for write tasks and diffing). */
    isGitRepo: z.boolean(),
    /** Absolute path of the isolated worktree for write tasks. */
    worktreePath: z.string().optional(),
    /** Branch name created for the worktree. */
    worktreeBranch: z.string().optional(),
    /** Commit the worktree/diff is based on. */
    baseRef: z.string().optional(),
  })
  .strict();
export type WorkspaceBinding = z.infer<typeof WorkspaceBinding>;

/**
 * The canonical task record. This is the single source of truth persisted by the store; the
 * `revision` field powers optimistic concurrency so two writers never clobber a transition.
 */
export const Task = z
  .object({
    id: z.string(),
    providerId: z.string(),
    status: TaskStatusSchema,
    mode: TaskMode,
    /** The instruction handed to the provider. */
    prompt: z.string(),
    /** Short human label (defaults to a slug of the prompt). */
    title: z.string(),
    policy: ExecutionPolicy,
    workspace: WorkspaceBinding,
    /**
     * Whether this is a resumable, multi-turn session. When false (the default), a completed turn is
     * terminal (`succeeded`) and the worktree is cleaned up — the crisp "delegate → verified diff →
     * done" flow. When true, a completed turn parks in `awaiting_input` so it can be continued/steered.
     */
    interactive: z.boolean().default(false),
    /** Provider session id enabling resume/continue, once known. */
    providerSessionId: z.string().optional(),
    /** Final structured result, once terminal-success or an intermediate turn completes. */
    result: TaskResult.optional(),
    /** Failure detail, when status is `failed`/`timed_out`. */
    error: z
      .object({ code: z.string(), message: z.string(), retriable: z.boolean().default(false) })
      .optional(),
    /** Free-form, caller-supplied metadata (labels, correlation ids). */
    metadata: z.record(z.unknown()).default({}),
    /** Monotonic revision, incremented on every persisted mutation (optimistic concurrency). */
    revision: z.number().int().nonnegative(),
    createdAt: z.string(),
    updatedAt: z.string(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
  })
  .strict();
export type Task = z.infer<typeof Task>;

/** Parameters accepted when starting a task, before defaults/validation are applied. */
export const StartTaskInput = z
  .object({
    providerId: z.string(),
    prompt: z.string().min(1, 'prompt must not be empty'),
    mode: TaskMode.default('read_only'),
    workspaceRoot: z.string(),
    subdir: z.string().optional(),
    title: z.string().optional(),
    /** Keep the session alive after the first turn for continue/steer (default one-shot). */
    interactive: z.boolean().default(false),
    /** Partial policy overrides; unspecified fields fall back to configured defaults. */
    policy: ExecutionPolicy.partial().optional(),
    /** Specific model to request, if the provider advertises models. */
    model: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();
export type StartTaskInput = z.infer<typeof StartTaskInput>;

/** Derive a short, filesystem/branch-safe title from a prompt. */
export const titleFromPrompt = (prompt: string, max = 60): string => {
  const firstLine = prompt.trim().split('\n', 1)[0] ?? '';
  const slug = firstLine.slice(0, max).trim();
  return slug.length > 0 ? slug : 'untitled task';
};
