import {
  DEFAULT_POLICY,
  ManualClock,
  asTaskId,
  newApprovalId,
  newArtifactId,
  newTaskId,
  type ApprovalRequest,
  type Artifact,
  type Task,
  type TaskId,
} from '@multicode/core';
import { SqliteStore } from '@multicode/persistence';

export const makeClock = (start = 1_700_000_000_000): ManualClock => new ManualClock(start);

export const freshStore = async (clock = makeClock()): Promise<SqliteStore> =>
  SqliteStore.open({ path: ':memory:', clock });

export const makeTask = (over: Partial<Task> = {}): Task => {
  const id = over.id ?? newTaskId();
  const now = over.createdAt ?? '2026-01-01T00:00:00.000Z';
  return {
    id,
    providerId: 'codex',
    status: 'pending',
    mode: 'read_only',
    prompt: 'do the thing',
    title: 'do the thing',
    policy: DEFAULT_POLICY,
    workspace: { root: '/repo', isGitRepo: true },
    interactive: false,
    metadata: {},
    revision: 0,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
};

export const makeApproval = (taskId: TaskId, over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: newApprovalId(),
  taskId,
  kind: 'exec_command',
  summary: 'run pnpm test',
  detail: { command: 'pnpm test' },
  providerToken: 'tok_1',
  status: 'pending',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

export const makeArtifact = (taskId: TaskId, over: Partial<Artifact> = {}): Artifact => ({
  id: newArtifactId(),
  taskId,
  kind: 'log',
  name: 'output.log',
  contentType: 'text/plain',
  sizeBytes: 5,
  content: 'hello',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

export const coerceTaskId = (raw: string): TaskId => asTaskId(raw);
