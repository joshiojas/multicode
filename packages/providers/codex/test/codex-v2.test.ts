import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noopLogger } from '@multicode/core';
import { makeRunContext, runConformance } from '@multicode/provider-sdk/conformance';
import type { ProviderFactory } from '@multicode/provider-sdk';
import { CodexV2Provider, createProvider } from '@multicode/provider-codex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkedTransports } from './mock-app-server.js';
import { MockCodexV2Server } from './mock-app-server-v2.js';

const v2Factory =
  (opts?: { failWith?: string }): ProviderFactory =>
  (init) => {
    const [clientT, serverT] = linkedTransports();
    new MockCodexV2Server(serverT, opts ?? {});
    return new CodexV2Provider({
      logger: init.logger,
      config: init.config,
      transportFactory: () => clientT,
    });
  };

describe('Codex v2 adapter conformance', () => {
  it('passes the shared conformance suite against the v2 thread/turn/item protocol', async () => {
    const report = await runConformance(v2Factory());
    expect(report.passed).toBe(true);
    // v2 advertises steering, so that gated check actually runs (unlike v1, which skips it).
    expect(report.checks.find((c) => c.name.startsWith('steering'))?.status).toBe('passed');
    expect(report.checks.filter((c) => c.status === 'passed').length).toBeGreaterThan(6);
  });
});

describe('Codex v2 adapter behavior', () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'mc-codex2-'));
  });
  afterEach(() => rmSync(workdir, { recursive: true, force: true }));

  it('runs a turn end-to-end: session, command, file change, message, tokens', async () => {
    const provider = v2Factory()({ id: 'codex', config: {}, logger: noopLogger });
    const h = makeRunContext({ cwd: workdir, policy: { approvals: 'never' } });
    const result = await provider.startTask({ prompt: 'do it', mode: 'read_only' }, h.ctx);

    expect(result.status).toBe('completed');
    expect(result.sessionId).toMatch(/^thread-/);
    expect(result.summary).toContain('do it');
    expect(result.tokenUsage?.totalTokens).toBe(15);

    const types = h.events.map((e) => e.type);
    expect(types).toContain('session');
    expect(types).toContain('command_started');
    expect(types).toContain('command_exited');
    expect(types).toContain('file_changed');
    await provider.dispose?.();
  });

  it('routes v2 approval requests through the run context', async () => {
    const provider = v2Factory()({ id: 'codex', config: {}, logger: noopLogger });
    const h = makeRunContext({ cwd: workdir, policy: { approvals: 'on_request' }, approvalDecision: 'denied' });
    await provider.startTask({ prompt: 'needs approval', mode: 'read_only' }, h.ctx);
    expect(h.approvalRequests.length).toBeGreaterThan(0);
    expect(h.approvalRequests[0]?.kind).toBe('exec_command');
    await provider.dispose?.();
  });

  it('cancels immediately when the signal is already aborted', async () => {
    const provider = v2Factory()({ id: 'codex', config: {}, logger: noopLogger });
    const h = makeRunContext({ cwd: workdir, preAborted: true });
    const result = await provider.startTask({ prompt: 'x', mode: 'read_only' }, h.ctx);
    expect(result.status).toBe('cancelled');
    await provider.dispose?.();
  });

  it('reports a failed turn on turn/completed(failed)', async () => {
    const provider = v2Factory({ failWith: 'model overloaded' })({ id: 'codex', config: {}, logger: noopLogger });
    const h = makeRunContext({ cwd: workdir, policy: { approvals: 'never' } });
    const result = await provider.startTask({ prompt: 'x', mode: 'read_only' }, h.ctx);
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('overloaded');
    await provider.dispose?.();
  });

  it('resumes a thread with continueTask (a second turn)', async () => {
    const provider = v2Factory()({ id: 'codex', config: {}, logger: noopLogger });
    const h1 = makeRunContext({ cwd: workdir, policy: { approvals: 'never' } });
    const first = await provider.startTask({ prompt: 'turn 1', mode: 'read_only' }, h1.ctx);
    const h2 = makeRunContext({ cwd: workdir, policy: { approvals: 'never' } });
    const second = await provider.continueTask!({ sessionId: first.sessionId!, prompt: 'turn 2' }, h2.ctx);
    expect(second.status).toBe('completed');
    expect(second.summary).toContain('turn 2');
    await provider.dispose?.();
  });
});

describe('createProvider protocol selection', () => {
  it('defaults to v2 and selects v1 via config.protocol', async () => {
    const v2 = createProvider({ id: 'codex', config: {}, logger: noopLogger });
    expect(v2.descriptor.protocolVersion).toBe('app-server-2');
    expect((await v2.capabilities()).steering).toBe(true);

    const v1 = createProvider({ id: 'codex', config: { protocol: 'v1' }, logger: noopLogger });
    expect(v1.descriptor.protocolVersion).toBe('app-server-1');
    expect((await v1.capabilities()).steering).toBe(false);
  });
});
