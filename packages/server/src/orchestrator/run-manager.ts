import type { TaskId } from '@multicode/core';

export type AbortReason = 'timeout' | 'cancel';

interface RunState {
  controller: AbortController;
  reason: AbortReason | null;
  timeout: NodeJS.Timeout;
}

/**
 * Tracks in-flight turns. Each running turn gets an {@link AbortController} and a hard timeout. The
 * distinction between a timeout-abort and a user-cancel is preserved (`reason`) so the orchestrator can
 * finalize the task as `timed_out` vs `cancelled` correctly.
 */
export class RunManager {
  readonly #runs = new Map<TaskId, RunState>();

  /** Begin tracking a turn; returns the signal the provider must observe. */
  start(taskId: TaskId, timeoutMs: number): AbortSignal {
    this.finish(taskId); // defensive: clear any stale run
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      const state = this.#runs.get(taskId);
      if (state && !state.controller.signal.aborted) {
        state.reason = 'timeout';
        state.controller.abort();
      }
    }, timeoutMs);
    timeout.unref?.();
    this.#runs.set(taskId, { controller, reason: null, timeout });
    return controller.signal;
  }

  /** Request cancellation of a running turn. Returns false if the task is not running. */
  cancel(taskId: TaskId): boolean {
    const state = this.#runs.get(taskId);
    if (!state) return false;
    if (!state.controller.signal.aborted) {
      state.reason = 'cancel';
      state.controller.abort();
    }
    return true;
  }

  /** Why the turn was aborted, if it was. */
  abortReason(taskId: TaskId): AbortReason | null {
    return this.#runs.get(taskId)?.reason ?? null;
  }

  isRunning(taskId: TaskId): boolean {
    return this.#runs.has(taskId);
  }

  /** Stop tracking a turn and clear its timeout. */
  finish(taskId: TaskId): void {
    const state = this.#runs.get(taskId);
    if (state) {
      clearTimeout(state.timeout);
      this.#runs.delete(taskId);
    }
  }

  /** Abort and clear all runs (shutdown). */
  cancelAll(): void {
    for (const taskId of [...this.#runs.keys()]) {
      this.cancel(taskId);
      this.finish(taskId);
    }
  }
}
