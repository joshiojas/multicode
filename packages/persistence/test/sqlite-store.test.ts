import {
  ConflictError,
  NotFoundError,
  StateTransitionError,
  type TaskId,
} from '@multicode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqliteStore } from '@multicode/persistence';
import { freshStore, makeApproval, makeArtifact, makeTask } from './helpers.js';

describe('SqliteStore', () => {
  let store: SqliteStore;

  beforeEach(async () => {
    store = await freshStore();
  });

  afterEach(async () => {
    await store.close();
  });

  describe('tasks', () => {
    it('creates and reads a task', async () => {
      const task = makeTask();
      await store.createTask(task);
      const loaded = await store.getTask(task.id);
      expect(loaded).toEqual(task);
    });

    it('returns null for a missing task', async () => {
      expect(await store.getTask('task_missing' as TaskId)).toBeNull();
    });

    it('lists and filters tasks', async () => {
      await store.createTask(makeTask({ providerId: 'codex', title: 'alpha' }));
      await store.createTask(makeTask({ providerId: 'other', title: 'beta' }));
      expect(await store.countTasks()).toBe(2);
      const codex = await store.listTasks({ providerId: 'codex' as never });
      expect(codex).toHaveLength(1);
      expect(codex[0]?.title).toBe('alpha');
      const beta = await store.listTasks({ titleContains: 'BET' });
      expect(beta).toHaveLength(1);
    });
  });

  describe('applyTransition', () => {
    it('bumps revision, changes status, and appends events atomically', async () => {
      const task = makeTask();
      await store.createTask(task);
      const { task: updated, events } = await store.applyTransition(task.id, {
        expectedRevision: 0,
        patch: { status: 'provisioning', startedAt: '2026-01-01T00:01:00.000Z' },
        events: [{ type: 'status.changed', from: 'pending', to: 'provisioning' }],
      });
      expect(updated.status).toBe('provisioning');
      expect(updated.revision).toBe(1);
      expect(updated.startedAt).toBe('2026-01-01T00:01:00.000Z');
      expect(events).toHaveLength(1);
      expect(events[0]?.seq).toBe(1);
    });

    it('rejects a stale revision (optimistic concurrency)', async () => {
      const task = makeTask();
      await store.createTask(task);
      await store.applyTransition(task.id, { expectedRevision: 0, patch: { status: 'provisioning' } });
      await expect(
        store.applyTransition(task.id, { expectedRevision: 0, patch: { status: 'running' } }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('rejects an illegal state transition and rolls back events', async () => {
      const task = makeTask();
      await store.createTask(task);
      await expect(
        store.applyTransition(task.id, {
          expectedRevision: 0,
          patch: { status: 'succeeded' },
          events: [{ type: 'note', message: 'should not persist' }],
        }),
      ).rejects.toBeInstanceOf(StateTransitionError);
      // The transaction rolled back: no events, revision unchanged.
      expect(await store.latestSeq(task.id)).toBe(0);
      expect((await store.getTask(task.id))?.revision).toBe(0);
    });

    it('throws NotFoundError for a missing task', async () => {
      await expect(
        store.applyTransition('task_x' as TaskId, { expectedRevision: 0 }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('events', () => {
    it('assigns contiguous per-task sequence numbers', async () => {
      const a = makeTask();
      const b = makeTask();
      await store.createTask(a);
      await store.createTask(b);
      await store.appendEvents(a.id, [
        { type: 'note', message: 'one' },
        { type: 'note', message: 'two' },
      ]);
      await store.appendEvents(b.id, [{ type: 'note', message: 'b-one' }]);
      await store.appendEvents(a.id, [{ type: 'note', message: 'three' }]);

      const aEvents = await store.getEvents(a.id);
      expect(aEvents.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(await store.latestSeq(a.id)).toBe(3);
      expect(await store.latestSeq(b.id)).toBe(1);
    });

    it('pages with afterSeq', async () => {
      const a = makeTask();
      await store.createTask(a);
      await store.appendEvents(
        a.id,
        Array.from({ length: 5 }, (_, i) => ({ type: 'note' as const, message: `m${i}` })),
      );
      const page = await store.getEvents(a.id, { afterSeq: 2, limit: 2 });
      expect(page.map((e) => e.seq)).toEqual([3, 4]);
    });

    it('applies event schema defaults on write', async () => {
      const a = makeTask();
      await store.createTask(a);
      const [ev] = await store.appendEvents(a.id, [{ type: 'note', message: 'x' }]);
      expect(ev && ev.type === 'note' ? ev.level : undefined).toBe('info');
    });
  });

  describe('approvals', () => {
    it('creates, resolves, and blocks double-resolution', async () => {
      const task = makeTask();
      await store.createTask(task);
      const approval = await store.createApproval(makeApproval(task.id));
      const resolved = await store.resolveApproval(approval.id, 'approved', { note: 'ok' });
      expect(resolved.status).toBe('approved');
      expect(resolved.decision).toBe('approved');
      expect(resolved.note).toBe('ok');
      await expect(store.resolveApproval(approval.id, 'denied')).rejects.toBeInstanceOf(
        ConflictError,
      );
    });

    it('lists pending approvals and expires them', async () => {
      const task = makeTask();
      await store.createTask(task);
      const a1 = await store.createApproval(makeApproval(task.id));
      await store.createApproval(makeApproval(task.id));
      expect(await store.listApprovals(task.id, { pendingOnly: true })).toHaveLength(2);
      await store.expireApproval(a1.id);
      expect(await store.listApprovals(task.id, { pendingOnly: true })).toHaveLength(1);
    });
  });

  describe('artifacts', () => {
    it('stores and lists artifacts', async () => {
      const task = makeTask();
      await store.createTask(task);
      const art = await store.putArtifact(makeArtifact(task.id));
      expect(await store.getArtifact(art.id)).toEqual(art);
      expect(await store.listArtifacts(task.id)).toHaveLength(1);
    });
  });

  describe('recovery', () => {
    it('finds only active tasks', async () => {
      await store.createTask(makeTask({ status: 'running' }));
      await store.createTask(makeTask({ status: 'awaiting_approval' }));
      await store.createTask(makeTask({ status: 'succeeded' }));
      await store.createTask(makeTask({ status: 'awaiting_input' }));
      const active = await store.findActiveTasks();
      expect(active.map((t) => t.status).sort()).toEqual(['awaiting_approval', 'running']);
    });
  });
});
