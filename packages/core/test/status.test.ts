import { describe, expect, it } from 'vitest';
import {
  TASK_STATUSES,
  allowedTransitions,
  assertTransition,
  canTransition,
  isActive,
  isResumableIdle,
  isTerminal,
  reconcileOnRecovery,
  StateTransitionError,
  type TaskStatus,
} from '@multicode/core';

describe('task status machine', () => {
  it('marks the four terminal states as terminal and nothing else', () => {
    const terminal = TASK_STATUSES.filter(isTerminal);
    expect(new Set(terminal)).toEqual(new Set(['succeeded', 'failed', 'cancelled', 'timed_out']));
  });

  it('terminal states have no outgoing transitions', () => {
    for (const s of TASK_STATUSES.filter(isTerminal)) {
      expect(allowedTransitions(s)).toHaveLength(0);
    }
  });

  it('allows the happy path pending → provisioning → running → succeeded', () => {
    expect(canTransition('pending', 'provisioning')).toBe(true);
    expect(canTransition('provisioning', 'running')).toBe(true);
    expect(canTransition('running', 'succeeded')).toBe(true);
  });

  it('rejects illegal transitions', () => {
    expect(canTransition('pending', 'succeeded')).toBe(false);
    expect(canTransition('succeeded', 'running')).toBe(false);
    expect(() => assertTransition('pending', 'succeeded')).toThrow(StateTransitionError);
  });

  it('every listed transition targets a real status', () => {
    for (const from of TASK_STATUSES) {
      for (const to of allowedTransitions(from)) {
        expect(TASK_STATUSES).toContain(to);
      }
    }
  });

  it('classifies active and resumable-idle states', () => {
    const active: TaskStatus[] = ['provisioning', 'running', 'awaiting_approval', 'cancelling'];
    for (const s of active) expect(isActive(s)).toBe(true);
    expect(isResumableIdle('awaiting_input')).toBe(true);
    expect(isActive('awaiting_input')).toBe(false);
  });

  describe('reconcileOnRecovery', () => {
    it('resumes an interrupted running task when the provider can resume', () => {
      expect(reconcileOnRecovery('running', true)).toEqual({
        to: 'awaiting_input',
        reason: expect.stringContaining('resumable'),
      });
    });

    it('fails an interrupted running task when the provider cannot resume', () => {
      expect(reconcileOnRecovery('running', false)?.to).toBe('failed');
    });

    it('completes a cancelling task as cancelled regardless of resume support', () => {
      expect(reconcileOnRecovery('cancelling', true)?.to).toBe('cancelled');
      expect(reconcileOnRecovery('cancelling', false)?.to).toBe('cancelled');
    });

    it('does nothing for terminal or idle tasks', () => {
      expect(reconcileOnRecovery('succeeded', true)).toBeNull();
      expect(reconcileOnRecovery('awaiting_input', true)).toBeNull();
    });

    it('only produces legal transitions', () => {
      for (const s of TASK_STATUSES) {
        for (const resume of [true, false]) {
          const r = reconcileOnRecovery(s, resume);
          if (r) expect(canTransition(s, r.to)).toBe(true);
        }
      }
    });
  });
});
