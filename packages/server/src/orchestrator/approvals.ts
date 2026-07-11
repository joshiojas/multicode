import { CancelledError, type ApprovalId, type TaskId } from '@multicode/core';
import type { ApprovalOutcome } from '@multicode/provider-sdk';

interface Pending {
  taskId: TaskId;
  resolve: (outcome: ApprovalOutcome) => void;
  reject: (err: Error) => void;
}

/**
 * In-process coordination between an adapter awaiting an approval decision and the MCP tool that
 * delivers it. The durable record lives in the store; this only holds the *promise resolvers* for
 * currently-blocked turns, so a restart (which drops these) simply expires the approvals during
 * recovery.
 */
export class ApprovalCoordinator {
  readonly #pending = new Map<ApprovalId, Pending>();

  /** Register a blocked approval and return the promise the adapter awaits. */
  register(id: ApprovalId, taskId: TaskId): Promise<ApprovalOutcome> {
    return new Promise<ApprovalOutcome>((resolve, reject) => {
      this.#pending.set(id, { taskId, resolve, reject });
    });
  }

  /** Deliver a decision to a waiting adapter. Returns false if nothing was waiting (e.g. after restart). */
  resolve(id: ApprovalId, outcome: ApprovalOutcome): boolean {
    const pending = this.#pending.get(id);
    if (!pending) return false;
    this.#pending.delete(id);
    pending.resolve(outcome);
    return true;
  }

  /** Reject every approval blocking a task (on cancel/timeout/shutdown) so its turn unblocks. */
  rejectByTask(taskId: TaskId, reason = 'task ended while awaiting approval'): void {
    for (const [id, pending] of this.#pending) {
      if (pending.taskId === taskId) {
        this.#pending.delete(id);
        pending.reject(new CancelledError(reason));
      }
    }
  }

  has(id: ApprovalId): boolean {
    return this.#pending.has(id);
  }

  get size(): number {
    return this.#pending.size;
  }
}
