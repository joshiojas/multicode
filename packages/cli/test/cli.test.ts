import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LIMITS, dataPaths, noopLogger, type MulticodeConfig } from '@multicode/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { git } from '@multicode/security';
import { bootstrap, createMcpServer } from '@multicode/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRegistry, loadConfig, saveConfig, starterConfig } from '../src/config-loader.js';
import { runInit } from '../src/commands/init.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const parse = (result: any): any => JSON.parse(result.content[0].text);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mc-cli-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('multicode init', () => {
  it('creates a valid config and data directories in the given data dir', async () => {
    const dataDir = join(dir, 'data');
    const code = await runInit({ dataDir });
    expect(code).toBe(0);
    const configPath = dataPaths(dataDir).configFile;
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(dataPaths(dataDir).worktrees)).toBe(true);
    const config = loadConfig({ dataDir });
    expect(config.dataDir).toBe(dataDir);
    expect(config.providers['codex']?.enabled).toBe(true);
  });

  it('does not overwrite an existing config without --force', async () => {
    const dataDir = join(dir, 'data');
    await runInit({ dataDir });
    saveConfig(dataPaths(dataDir).configFile, { ...starterConfig('/x', { dataDir }), workspaceRoots: ['/sentinel'] });
    await runInit({ dataDir });
    expect(loadConfig({ dataDir }).workspaceRoots).toEqual(['/sentinel']);
  });
});

describe('composition root wires Codex as a built-in', () => {
  it('loads the codex provider with static capabilities (no process spawn)', async () => {
    const registry = createRegistry(noopLogger);
    await registry.load([{ id: 'codex', enabled: true, config: {} }]);
    expect(registry.has('codex')).toBe(true);
    expect(registry.get('codex').descriptor.id).toBe('codex');
    expect(registry.capabilitiesOf('codex').writeMode).toBe(true);
    await registry.dispose();
  });
});

describe('end-to-end: shipped server + package-provider loading + MCP tools', () => {
  it('starts a task through the MCP tools against a real repo and reaches success', async () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    await git(repo, ['init', '-q']);
    await git(repo, ['config', 'user.email', 't@t.dev']);
    await git(repo, ['config', 'user.name', 'T']);
    writeFileSync(join(repo, 'README.md'), '# repo\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'init']);

    const config: MulticodeConfig = {
      version: 1,
      dataDir: join(dir, 'data'),
      workspaceRoots: [repo],
      defaults: {
        mode: 'read_only',
        sandbox: 'read_only',
        network: 'disabled',
        approvals: 'never',
        limits: { ...DEFAULT_LIMITS, timeoutMs: 10_000, cancelGraceMs: 200 },
      },
      // The fake provider is loaded as a *package* provider through the SDK's testing entry point,
      // exercising the registry's dynamic-import + isolation path end to end.
      providers: {
        fake: { enabled: true, package: '@multicode/provider-sdk/testing', args: [], passthroughEnv: [], config: {} },
      },
      transport: { type: 'stdio' },
      logging: { level: 'error', pretty: false },
      telemetry: { enabled: false },
    };

    const registry = createRegistry(noopLogger);
    const { orchestrator, store } = await bootstrap({ config, registry, logger: noopLogger });
    expect(registry.info('fake')?.status).toBe('ready');
    expect(registry.info('fake')?.source).toBe('package');

    const server = createMcpServer(orchestrator);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'e2e', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const startResult = await client.callTool({
      name: 'multicode_start_task',
      arguments: { providerId: 'fake', prompt: 'inspect the repo', workspaceRoot: repo, mode: 'read_only' },
    });
    const { task } = parse(startResult);
    expect(task.id).toBeDefined();

    let status = task.status;
    for (let i = 0; i < 200 && status !== 'succeeded' && status !== 'failed'; i += 1) {
      await sleep(10);
      const got = parse(await client.callTool({ name: 'multicode_get_task', arguments: { taskId: task.id } }));
      status = got.task.status;
    }
    expect(status).toBe('succeeded');

    await client.close();
    await orchestrator.shutdown();
    await store.close();
  });
});
