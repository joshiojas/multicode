import { StateTransitionError } from '../errors.js';

/**
 * The lifecycle states a task moves through. The set is provider-neutral: a provider that cannot,
 * say, request approvals simply never drives a task into `awaiting_approval`.
 *
 * ```
 *  pending ──▶ provisioning ──▶ running ──▶ succeeded (terminal)
 *     │             │             │  ▲  │
 *     │             │             │  │  ├─▶ awaiting_approval ─┐
 *     │             │             │  └──── awaiting_input ◀────┤ (resume)
 *     │             │             │                            │
 *     └──────┬──────┴─────────────┴──▶ cancelling ──▶ cancelled (terminal)
 *            │                                         failed / timed_out (terminal)
 * ```
 */
export const TASK_STATUSES = [
  'pending',
  'provisioning',
  'running',
  'awaiting_approval',
  'awaiting_input',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

/** States in which a provider process / session is expected to be live. */
const ACTIVE: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'provisioning',
  'running',
  'awaiting_approval',
  'cancelling',
]);

/** States in which the task is idle but can accept a `continue`/`steer` (if the provider resumes). */
const RESUMABLE_IDLE: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['awaiting_input']);

export const isTerminal = (status: TaskStatus): boolean => TERMINAL.has(status);
export const isActive = (status: TaskStatus): boolean => ACTIVE.has(status);
export const isResumableIdle = (status: TaskStatus): boolean => RESUMABLE_IDLE.has(status);
export const isSuccess = (status: TaskStatus): boolean => status === 'succeeded';

/**
 * Allowed transitions. A transition not present here is illegal and rejected by
 * {@link assertTransition}. Terminal states have no outgoing edges.
 */
const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['provisioning', 'cancelling', 'failed'],
  provisioning: ['running', 'cancelling', 'failed', 'timed_out'],
  running: [
    'awaiting_approval',
    'awaiting_input',
    'succeeded',
    'failed',
    'cancelling',
    'timed_out',
  ],
  // An expired/abandoned approval can leave the task idle-resumable (awaiting_input).
  awaiting_approval: ['running', 'awaiting_input', 'cancelling', 'failed', 'timed_out'],
  awaiting_input: ['running', 'cancelling', 'succeeded', 'failed', 'timed_out'],
  // `cancelling` may still resolve to success/failure if the provider finished during the grace period.
  cancelling: ['cancelled', 'failed', 'succeeded', 'timed_out'],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export const canTransition = (from: TaskStatus, to: TaskStatus): boolean =>
  TRANSITIONS[from].includes(to);

/** Throw {@link StateTransitionError} unless `from → to` is a legal edge. */
export const assertTransition = (from: TaskStatus, to: TaskStatus): void => {
  if (!canTransition(from, to)) {
    throw new StateTransitionError(`Illegal task transition ${from} → ${to}`, {
      details: { from, to, allowed: TRANSITIONS[from] },
    });
  }
};

/** The legal outgoing transitions from `status` (empty for terminal states). */
export const allowedTransitions = (status: TaskStatus): readonly TaskStatus[] =>
  TRANSITIONS[status];

/**
 * Reconcile an interrupted task after a Multicode restart. Any task found in an {@link isActive}
 * state on boot had its provider process killed with the previous Multicode instance, so the turn
 * cannot continue. The task is moved to:
 *  - `awaiting_input` when the provider can resume the session (so the user may `continue`), or
 *  - `failed` otherwise.
 *
 * Returns `null` when no reconciliation is needed (task already terminal or idle).
 */
export const reconcileOnRecovery = (
  status: TaskStatus,
  providerCanResume: boolean,
): { to: TaskStatus; reason: string } | null => {
  if (!isActive(status)) return null;
  if (status === 'cancelling') {
    return { to: 'cancelled', reason: 'Cancellation completed during restart.' };
  }
  // `provisioning` has no established session yet, so it can never resume — always fail it.
  if (status !== 'provisioning' && providerCanResume) {
    return {
      to: 'awaiting_input',
      reason: 'Multicode restarted; the provider turn was interrupted but the session is resumable.',
    };
  }
  return {
    to: 'failed',
    reason: 'Multicode restarted; the provider turn was interrupted and cannot be resumed.',
  };
};
