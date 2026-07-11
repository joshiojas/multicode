import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LIMITS,
  noopLogger,
  type MulticodeConfig,
  type TaskId,
} from '@multicode/core';
import { SqliteStore } from '@multicode/persistence';
import { WorkspaceGuard, WorktreeManager, git } from '@multicode/security';
import { ProviderRegistry } from '@multicode/provider-sdk';
import { createFakeProvider, type FakeProviderOptions } from '@multicode/provider-sdk/testing';
import { Orchestrator } from '@multicode/server';

export interface TestHarness {
  readonly orchestrator: Orchestrator;
  readonly store: SqliteStore;
  readonly registry: ProviderRegistry;
  readonly repo: string;
  readonly dir: string;
  cleanup(): Promise<void>;
}

export const seedRepo = async (repo: string): Promise<void> => {
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.email', 'test@multicode.dev']);
  await git(repo, ['config', 'user.name', 'Multicode Test']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'initial']);
};

export const makeHarness = async (
  fakeOptions: FakeProviderOptions = {},
): Promise<TestHarness> => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-orch-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  await seedRepo(repo);

  const config: MulticodeConfig = {
    version: 1,
    dataDir: join(dir, 'data'),
    workspaceRoots: [repo],
    defaults: {
      mode: 'read_only',
      sandbox: 'read_only',
      network: 'disabled',
      approvals: 'on_request',
      limits: { ...DEFAULT_LIMITS, timeoutMs: 10_000, cancelGraceMs: 200 },
    },
    providers: { fake: { enabled: true, args: [], passthroughEnv: [], config: {} } },
    transport: { type: 'stdio' },
    logging: { level: 'error', pretty: false },
    telemetry: { enabled: false },
  };

  const store = await SqliteStore.open({ path: ':memory:' });
  const registry = new ProviderRegistry();
  registry.registerBuiltin('fake', createFakeProvider(fakeOptions));
  await registry.load([{ id: 'fake', enabled: true, config: {} }]);

  const guard = WorkspaceGuard.fromRoots([repo]);
  const worktrees = new WorktreeManager(join(dir, 'worktrees'));
  const orchestrator = new Orchestrator({
    store,
    registry,
    guard,
    worktrees,
    config,
    logger: noopLogger,
  });

  return {
    orchestrator,
    store,
    registry,
    repo,
    dir,
    cleanup: async () => {
      await orchestrator.shutdown();
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const waitFor = async (
  pred: () => boolean | Promise<boolean>,
  opts: { timeout?: number; interval?: number } = {},
): Promise<void> => {
  const timeout = opts.timeout ?? 3_000;
  const interval = opts.interval ?? 10;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await pred()) return;
    await sleep(interval);
  }
  throw new Error('waitFor timed out');
};

export const asId = (id: string): TaskId => id as TaskId;
