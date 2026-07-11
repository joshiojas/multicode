import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noopLogger } from '@multicode/core';
import { runConformance, makeRunContext } from '@multicode/provider-sdk/conformance';
import type { ProviderFactory } from '@multicode/provider-sdk';
import {
  CodexProvider,
  authStatusFromFilesystem,
  mapApprovalPolicy,
  mapCodexMsg,
  mapDecision,
  mapSandbox,
} from '@multicode/provider-codex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockCodexAppServer, linkedTransports } from './mock-app-server.js';

const codexFactory =
  (opts?: { failWith?: string }): ProviderFactory =>
  (init) => {
    const [clientT, serverT] = linkedTransports();
    new MockCodexAppServer(serverT, opts ?? {});
    return new CodexProvider({
      logger: init.logger,
      config: init.config,
      transportFactory: () => clientT,
    });
  };

describe('Codex adapter conformance', () => {
  it('passes the shared provider conformance suite against the App Server contract', async () => {
    const report = await runConformance(codexFactory());
    expect(report.passed).toBe(true);
    expect(report.checks.filter((c) => c.status === 'passed').length).toBeGreaterThan(5);
  });
});

describe('Codex adapter behavior', () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'mc-codex-'));
  });
  afterEach(() => rmSync(workdir, { recursive: true, force: true }));

  it('streams events, reports a session and token usage, and completes', async () => {
    const provider = codexFactory()({ id: 'codex', config: {}, logger: noopLogger });
    const h = makeRunContext({ cwd: workdir, policy: { approvals: 'never' } });
    const result = await provider.startTask({ prompt: 'do work', mode: 'read_only' }, h.ctx);

    expect(result.status).toBe('completed');
    expect(result.sessionId).toMatch(/^conv-/);
    expect(result.summary).toContain('do work');
    expect(result.tokenUsage?.totalTokens).toBe(15);

    const types = h.events.map((e) => e.type);
    expect(types).toContain('session');
    expect(types).toContain('command_started');
    expect(types).toContain('command_exited');
    expect(types).toContain('file_changed');
    await provider.dispose?.();
  });

  it('performs the REQUIRED addConversationListener handshake (else no events arrive)', async () => {
    const [clientT, serverT] = linkedTransports();
    const mock = new MockCodexAppServer(serverT);
    const provider = new CodexProvider({
      logger: noopLogger,
      config: {},
      transportFactory: () => clientT,
    });
    const h = makeRunContext({ cwd: workdir, policy: { approvals: 'never' } });
    const result = await provider.startTask({ prompt: 'x', mode: 'read_only' }, h.ctx);
    // The mock only delivers events to subscribed conversations; completion proves we subscribed.
    expect(result.status).toBe('completed');
    expect(mock.subscriptions).toContain(result.sessionId);
    await provider.dispose?.();
  });

  it('decodes base64 command output chunks end-to-end', async () => {
    const provider = codexFactory()({ id: 'codex', config: {}, logger: noopLogger });
    const h = makeRunContext({ cwd: workdir, policy: { approvals: 'never' } });
    await provider.startTask({ prompt: 'x', mode: 'read_only' }, h.ctx);
    const out = h.events.find((e) => e.type === 'command_output');
    expect(out && out.type === 'command_output' ? out.chunk : '').toBe('ok\n');
    await provider.dispose?.();
  });

  it('routes approval requests through the run context', async () => {
    const provider = codexFactory()({ id: 'codex', config: {}, logger: noopLogger });
    const h = makeRunContext({ cwd: workdir, policy: { approvals: 'on_request' }, approvalDecision: 'denied' });
    await provider.startTask({ prompt: 'needs approval', mode: 'read_only' }, h.ctx);
    expect(h.approvalRequests.length).toBeGreaterThan(0);
    expect(h.approvalRequests[0]?.kind).toBe('exec_command');
    await provider.dispose?.();
  });

  it('cancels immediately when the signal is already aborted', async () => {
    const provider = codexFactory()({ id: 'codex', config: {}, logger: noopLogger });
    const h = makeRunContext({ cwd: workdir, preAborted: true });
    const result = await provider.startTask({ prompt: 'x', mode: 'read_only' }, h.ctx);
    expect(result.status).toBe('cancelled');
    await provider.dispose?.();
  });

  it('reports a failed turn on a stream error', async () => {
    const provider = codexFactory({ failWith: 'model overloaded' })({ id: 'codex', config: {}, logger: noopLogger });
    const h = makeRunContext({ cwd: workdir, policy: { approvals: 'never' } });
    const result = await provider.startTask({ prompt: 'x', mode: 'read_only' }, h.ctx);
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('overloaded');
    await provider.dispose?.();
  });

  it('resumes a session with continueTask', async () => {
    const provider = codexFactory()({ id: 'codex', config: {}, logger: noopLogger });
    const h1 = makeRunContext({ cwd: workdir, policy: { approvals: 'never' } });
    const first = await provider.startTask({ prompt: 'turn 1', mode: 'read_only' }, h1.ctx);
    const h2 = makeRunContext({ cwd: workdir, policy: { approvals: 'never' } });
    const second = await provider.continueTask!(
      { sessionId: first.sessionId!, prompt: 'turn 2' },
      h2.ctx,
    );
    expect(second.status).toBe('completed');
    expect(second.summary).toContain('turn 2');
    await provider.dispose?.();
  });
});

describe('Codex mapping helpers', () => {
  it('maps approval policies to Codex values', () => {
    expect(mapApprovalPolicy('never')).toBe('never');
    expect(mapApprovalPolicy('on_request')).toBe('on-request');
    expect(mapApprovalPolicy('on_failure')).toBe('on-failure');
    expect(mapApprovalPolicy('auto')).toBe('on-request');
  });

  it('maps sandbox levels', () => {
    expect(mapSandbox('read_only')).toBe('read-only');
    expect(mapSandbox('workspace_write')).toBe('workspace-write');
    expect(mapSandbox('danger_full_access')).toBe('danger-full-access');
  });

  it('maps decisions', () => {
    expect(mapDecision('approved')).toBe('approved');
    expect(mapDecision('denied')).toBe('denied');
  });

  it('maps codex event payloads to provider events', () => {
    expect(mapCodexMsg({ type: 'agent_message', message: 'hi' }).events).toEqual([
      { type: 'message', role: 'assistant', text: 'hi' },
    ]);
    expect(mapCodexMsg({ type: 'task_complete', last_agent_message: 'done' }).control).toEqual({
      type: 'complete',
      message: 'done',
    });
    expect(mapCodexMsg({ type: 'unknown_future_event' }).events).toEqual([]);
    const diff = mapCodexMsg({
      type: 'turn_diff',
      unified_diff: '--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+x\n',
    });
    expect(diff.events).toEqual([{ type: 'file_changed', path: 'a.ts', changeType: 'added' }]);
  });

  it('decodes base64 exec output chunks', () => {
    const ev = mapCodexMsg({
      type: 'exec_command_output_delta',
      stream: 'stdout',
      chunk: Buffer.from('hi there').toString('base64'),
    });
    expect(ev.events).toEqual([{ type: 'command_output', stream: 'stdout', chunk: 'hi there' }]);
  });

  it('maps patch_apply_end changes to file_changed events', () => {
    const ev = mapCodexMsg({
      type: 'patch_apply_end',
      changes: { 'a.ts': { add: {} }, 'b.ts': { delete: {} }, 'c.ts': { update: {} } },
    });
    expect(ev.events).toEqual([
      { type: 'file_changed', path: 'a.ts', changeType: 'added' },
      { type: 'file_changed', path: 'b.ts', changeType: 'deleted' },
      { type: 'file_changed', path: 'c.ts', changeType: 'modified' },
    ]);
  });

  it('parses exec_command_end duration in serde {secs,nanos} form', () => {
    const ev = mapCodexMsg({
      type: 'exec_command_end',
      call_id: 'c1',
      exit_code: 0,
      duration: { secs: 1, nanos: 500_000_000 },
    });
    const e = ev.events[0];
    expect(e && e.type === 'command_exited' ? e.durationMs : -1).toBe(1500);
  });
});

describe('Codex auth status (no token exposure)', () => {
  it('reports authenticated when auth.json exists, without reading it', () => {
    const home = mkdtempSync(join(tmpdir(), 'mc-codexhome-'));
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ token: 'SECRET-DO-NOT-READ' }));
    const status = authStatusFromFilesystem({ CODEX_HOME: home } as NodeJS.ProcessEnv);
    expect(status.authenticated).toBe(true);
    // The returned status must not contain the token.
    expect(JSON.stringify(status)).not.toContain('SECRET');
    rmSync(home, { recursive: true, force: true });
  });

  it('reports unauthenticated when auth.json is absent', () => {
    const home = mkdtempSync(join(tmpdir(), 'mc-codexhome-'));
    const status = authStatusFromFilesystem({ CODEX_HOME: home } as NodeJS.ProcessEnv);
    expect(status.authenticated).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});
