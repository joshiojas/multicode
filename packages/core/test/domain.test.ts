import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  StartTaskInput,
  TaskEventData,
  TaskResult,
  Verification,
  isEventType,
  requiresWorktree,
  sandboxRank,
  titleFromPrompt,
  type TaskEvent,
} from '@multicode/core';

describe('policy helpers', () => {
  it('ranks sandbox levels monotonically', () => {
    expect(sandboxRank('read_only')).toBeLessThan(sandboxRank('workspace_write'));
    expect(sandboxRank('workspace_write')).toBeLessThan(sandboxRank('danger_full_access'));
  });

  it('only write mode requires a worktree', () => {
    expect(requiresWorktree('write')).toBe(true);
    expect(requiresWorktree('read_only')).toBe(false);
  });

  it('default policy is locked down', () => {
    expect(DEFAULT_POLICY.mode).toBe('read_only');
    expect(DEFAULT_POLICY.sandbox).toBe('read_only');
    expect(DEFAULT_POLICY.network).toBe('disabled');
  });
});

describe('StartTaskInput', () => {
  it('defaults mode to read_only', () => {
    const input = StartTaskInput.parse({
      providerId: 'codex',
      prompt: 'do a thing',
      workspaceRoot: '/repo',
    });
    expect(input.mode).toBe('read_only');
  });

  it('rejects an empty prompt', () => {
    expect(() =>
      StartTaskInput.parse({ providerId: 'codex', prompt: '', workspaceRoot: '/repo' }),
    ).toThrow();
  });
});

describe('titleFromPrompt', () => {
  it('uses the first line, trimmed and capped', () => {
    expect(titleFromPrompt('Fix the bug\nmore detail')).toBe('Fix the bug');
    expect(titleFromPrompt('x'.repeat(200)).length).toBeLessThanOrEqual(60);
  });

  it('falls back for blank prompts', () => {
    expect(titleFromPrompt('   \n  ')).toBe('untitled task');
  });
});

describe('events', () => {
  it('parses a discriminated event payload', () => {
    const parsed = TaskEventData.parse({ type: 'status.changed', from: 'pending', to: 'running' });
    expect(parsed.type).toBe('status.changed');
  });

  it('rejects an unknown event type', () => {
    expect(() => TaskEventData.parse({ type: 'nope' })).toThrow();
  });

  it('isEventType narrows correctly', () => {
    const ev = {
      id: 'evt_1',
      taskId: 'task_1',
      seq: 1,
      at: '2026-01-01T00:00:00.000Z',
      type: 'command.exited',
      command: 'pnpm test',
      exitCode: 0,
      durationMs: 10,
      killed: false,
    } satisfies TaskEvent;
    if (isEventType(ev, 'command.exited')) {
      expect(ev.exitCode).toBe(0);
    } else {
      expect.unreachable();
    }
  });
});

describe('TaskResult', () => {
  it('requires verification and confirms changes', () => {
    const verification = Verification.parse({ changeConfirmed: true, commands: [] });
    const result = TaskResult.parse({ verification });
    expect(result.summary).toBe('');
    expect(result.verification.changeConfirmed).toBe(true);
  });
});
