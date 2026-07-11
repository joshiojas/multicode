import { existsSync } from 'node:fs';
import { asTaskId, type TaskId } from '@multicode/core';
import { afterEach, describe, expect, it } from 'vitest';
import { makeHarness, waitFor, type TestHarness } from './helpers.js';

let harness: TestHarness;

afterEach(async () => {
  await harness?.cleanup();
});

describe('Orchestrator (end-to-end with FakeProvider + real git)', () => {
  it('lists providers with negotiated capabilities', async () => {
    harness = await makeHarness();
    const providers = harness.orchestrator.listProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).toBe('fake');
    expect(providers[0]?.status).toBe('ready');
    expect(providers[0]?.capabilities?.writeMode).toBe(true);
  });

  it('runs a read-only task to success with verified command outcomes', async () => {
    harness = await makeHarness();
    const started = await harness.orchestrator.startTask({
      providerId: 'fake',
      prompt: 'review the code',
      workspaceRoot: harness.repo,
      mode: 'read_only',
      policy: { approvals: 'never' },
    });
    const task = await harness.orchestrator.awaitTask(asTaskId(started.id));
    expect(task.status).toBe('succeeded');
    expect(task.result?.summary).toContain('review the code');
    // Command outcomes are derived from observed events, not the agent's claims.
    expect(task.result?.verification.commands.some((c) => c.exitCode === 0)).toBe(true);
    // No diff for a read-only task.
    expect(task.result?.verification.changeConfirmed).toBe(false);

    const events = await harness.orchestrator.getEvents(asTaskId(started.id));
    expect(events.some((e) => e.type === 'provider.message')).toBe(true);
    expect(events.some((e) => e.type === 'result.ready')).toBe(true);
  });

  it('runs a write task in an isolated worktree and verifies the diff, then cleans up', async () => {
    harness = await makeHarness();
    const started = await harness.orchestrator.startTask({
      providerId: 'fake',
      prompt: 'add release notes',
      workspaceRoot: harness.repo,
      mode: 'write',
      policy: { sandbox: 'workspace_write', approvals: 'never' },
    });
    const worktreePath = (await harness.orchestrator.getTask(asTaskId(started.id))).workspace
      .worktreePath;
    expect(worktreePath).toBeDefined();

    const task = await harness.orchestrator.awaitTask(asTaskId(started.id));
    expect(task.status).toBe('succeeded');
    expect(task.result?.verification.changeConfirmed).toBe(true);

    const diff = await harness.orchestrator.getDiff(asTaskId(started.id));
    expect(diff?.summary.filesChanged).toBe(1);
    expect(diff?.summary.files[0]?.path).toBe('FAKE_NOTES.md');
    expect(diff?.summary.files[0]?.changeType).toBe('added');
    expect(diff?.patch).toContain('FAKE_NOTES.md');

    // The diff patch is stored as an artifact.
    const artifacts = await harness.orchestrator.getArtifacts(asTaskId(started.id));
    expect(artifacts.some((a) => a.kind === 'diff')).toBe(true);

    // The throwaway worktree is cleaned up on terminal state.
    expect(worktreePath && existsSync(worktreePath)).toBe(false);
    // The real repo working tree is untouched.
    expect(existsSync(`${harness.repo}/FAKE_NOTES.md`)).toBe(false);
  });

  it('routes an approval request and resumes after approval', async () => {
    harness = await makeHarness();
    const started = await harness.orchestrator.startTask({
      providerId: 'fake',
      prompt: 'run tests, ask first',
      workspaceRoot: harness.repo,
      mode: 'read_only',
      policy: { approvals: 'on_request' },
    });
    const id = asTaskId(started.id);

    await waitFor(async () => (await harness.orchestrator.getTask(id)).status === 'awaiting_approval');
    const pending = await harness.orchestrator.listApprovals(id, true);
    expect(pending).toHaveLength(1);

    await harness.orchestrator.respondApproval(pending[0]!.id as never, 'approved', 'go ahead');
    const task = await harness.orchestrator.awaitTask(id);
    expect(task.status).toBe('succeeded');

    const events = await harness.orchestrator.getEvents(id);
    expect(events.some((e) => e.type === 'approval.requested')).toBe(true);
    expect(events.some((e) => e.type === 'approval.resolved')).toBe(true);
  });

  it('cancels a running task', async () => {
    harness = await makeHarness({ stepDelayMs: 80 });
    const started = await harness.orchestrator.startTask({
      providerId: 'fake',
      prompt: 'long running task',
      workspaceRoot: harness.repo,
      mode: 'read_only',
      policy: { approvals: 'never' },
    });
    const id = asTaskId(started.id);
    await waitFor(async () => (await harness.orchestrator.getTask(id)).status === 'running');
    await harness.orchestrator.cancelTask(id);
    const task = await harness.orchestrator.awaitTask(id);
    expect(task.status).toBe('cancelled');
  });

  it('supports interactive continue on a resumable session', async () => {
    harness = await makeHarness();
    const started = await harness.orchestrator.startTask({
      providerId: 'fake',
      prompt: 'first turn',
      workspaceRoot: harness.repo,
      mode: 'read_only',
      interactive: true,
      policy: { approvals: 'never' },
    });
    const id = asTaskId(started.id);
    const afterFirst = await harness.orchestrator.awaitTask(id);
    expect(afterFirst.status).toBe('awaiting_input');
    expect(afterFirst.providerSessionId).toBeDefined();

    await harness.orchestrator.continueTask(id, 'second turn');
    const afterSecond = await harness.orchestrator.awaitTask(id);
    expect(afterSecond.status).toBe('awaiting_input');

    const events = await harness.orchestrator.getEvents(id);
    const resultReady = events.filter((e) => e.type === 'result.ready');
    expect(resultReady.length).toBe(2);
    // The user's continue message is recorded.
    expect(
      events.some((e) => e.type === 'provider.message' && 'text' in e && e.text === 'second turn'),
    ).toBe(true);
  });

  it('fails a task when the provider errors', async () => {
    harness = await makeHarness({ failWith: 'boom' });
    const started = await harness.orchestrator.startTask({
      providerId: 'fake',
      prompt: 'will fail',
      workspaceRoot: harness.repo,
      mode: 'read_only',
      policy: { approvals: 'never' },
    });
    const task = await harness.orchestrator.awaitTask(asTaskId(started.id));
    expect(task.status).toBe('failed');
    expect(task.error?.code).toBeDefined();
    // The provider's structured error message must be preserved, not mangled to "Unknown error".
    expect(task.error?.message).toContain('boom');
  });

  it('rejects a task whose workspace root is not approved', async () => {
    harness = await makeHarness();
    await expect(
      harness.orchestrator.startTask({
        providerId: 'fake',
        prompt: 'escape',
        workspaceRoot: '/etc',
        mode: 'read_only',
      }),
    ).rejects.toThrow();
  });

  it('recovers interrupted tasks on boot', async () => {
    harness = await makeHarness();
    // Simulate a crash: write a running task with a session directly into the store.
    const now = '2026-01-01T00:00:00.000Z';
    const resumable: TaskId = asTaskId('task_recover_resumable');
    const orphan: TaskId = asTaskId('task_recover_orphan');
    await harness.store.createTask({
      id: resumable,
      providerId: 'fake',
      status: 'running',
      mode: 'read_only',
      prompt: 'was running',
      title: 'was running',
      policy: seedPolicy(),
      workspace: { root: harness.repo, isGitRepo: true },
      interactive: true,
      providerSessionId: 'sess-1',
      metadata: {},
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });
    await harness.store.createTask({
      id: orphan,
      providerId: 'fake',
      status: 'running',
      mode: 'read_only',
      prompt: 'no session',
      title: 'no session',
      policy: seedPolicy(),
      workspace: { root: harness.repo, isGitRepo: true },
      interactive: true,
      metadata: {},
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });

    const summary = await harness.orchestrator.recover();
    expect(summary.inspected).toBeGreaterThanOrEqual(2);

    expect((await harness.orchestrator.getTask(resumable)).status).toBe('awaiting_input');
    expect((await harness.orchestrator.getTask(orphan)).status).toBe('failed');
  });
});

// Minimal valid policy for directly-seeded tasks in the recovery test.
const seedPolicy = () => ({
  mode: 'read_only' as const,
  sandbox: 'read_only' as const,
  network: 'disabled' as const,
  approvals: 'never' as const,
  limits: { timeoutMs: 10_000, cancelGraceMs: 200, maxOutputBytes: 1_000_000, maxEvents: 10_000 },
  extraReadRoots: [],
  passthroughEnv: [],
});
