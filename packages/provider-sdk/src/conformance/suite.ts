import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProviderCapabilities,
  ProviderDescriptor,
  noopLogger,
  type Logger,
} from '@multicode/core';
import type { ProviderAdapter, ProviderFactory } from '../adapter.js';
import { isSdkCompatible } from '../registry.js';
import { makeRunContext } from './harness.js';

export interface ConformanceCheck {
  readonly name: string;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly message?: string;
}

export interface ConformanceReport {
  readonly provider: string;
  readonly checks: ConformanceCheck[];
  readonly passed: boolean;
}

export interface ConformanceOptions {
  readonly logger?: Logger;
  /** Throw an error summarizing failures at the end (default true). */
  readonly throwOnFailure?: boolean;
  /** Config passed to the factory. */
  readonly config?: Record<string, unknown>;
}

const SECRETY_KEYS = ['token', 'secret', 'apikey', 'api_key', 'password', 'credential', 'bearer'];

/**
 * Run the shared provider conformance suite against a factory. Every provider — built-in or
 * third-party — must pass this. Checks are gated on the provider's *declared* capabilities, so a
 * limited provider is only held to what it claims, but a provider that claims a capability must
 * actually honor it (streaming emits events, cancellation stops promptly, approvals are requested,
 * resume returns a session, etc.).
 */
export const runConformance = async (
  factory: ProviderFactory,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> => {
  const logger = options.logger ?? noopLogger;
  const checks: ConformanceCheck[] = [];
  const workdir = mkdtempSync(join(tmpdir(), 'mc-conformance-'));

  const record = async (name: string, gate: boolean, fn: () => Promise<void>): Promise<void> => {
    if (!gate) {
      checks.push({ name, status: 'skipped' });
      return;
    }
    try {
      await fn();
      checks.push({ name, status: 'passed' });
    } catch (err) {
      checks.push({ name, status: 'failed', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const assert = (cond: unknown, msg: string): void => {
    if (!cond) throw new Error(msg);
  };

  let adapter: ProviderAdapter;
  let caps: ProviderCapabilities;
  try {
    adapter = await factory({ id: 'conformance', config: options.config ?? {}, logger });
    caps = ProviderCapabilities.parse(await adapter.capabilities());
  } catch (err) {
    const report: ConformanceReport = {
      provider: 'unknown',
      checks: [{ name: 'construct adapter', status: 'failed', message: String(err) }],
      passed: false,
    };
    rmSync(workdir, { recursive: true, force: true });
    if (options.throwOnFailure !== false) throw conformanceError(report);
    return report;
  }

  const providerName = adapter.descriptor.id;

  try {
    await record('descriptor is valid and SDK-compatible', true, async () => {
      const desc = ProviderDescriptor.parse(adapter.descriptor);
      assert(isSdkCompatible(desc.sdkVersion), `SDK version ${desc.sdkVersion} is not compatible`);
    });

    await record('capabilities validate', true, async () => {
      ProviderCapabilities.parse(await adapter.capabilities());
    });

    await record('authStatus never leaks a secret', true, async () => {
      const status = await adapter.authStatus();
      for (const key of Object.keys(status)) {
        assert(
          !SECRETY_KEYS.includes(key.toLowerCase()),
          `authStatus exposes a secret-like field "${key}"`,
        );
      }
    });

    await record('read-only task completes and streams', caps.readOnlyMode, async () => {
      const h = makeRunContext({ cwd: workdir, policy: { mode: 'read_only', approvals: 'never' } });
      const result = await adapter.startTask({ prompt: 'read the code', mode: 'read_only' }, h.ctx);
      assert(result.status === 'completed', `expected completed, got ${result.status}`);
      if (caps.streaming) assert(h.events.length > 0, 'streaming provider emitted no events');
      if (caps.structuredResult) assert(result.structuredOutput !== undefined, 'no structured output');
    });

    await record('resume: continueTask defined and returns a session', caps.resume, async () => {
      assert(typeof adapter.continueTask === 'function', 'resume capable but continueTask missing');
      const h = makeRunContext({ cwd: workdir, policy: { approvals: 'never' } });
      const start = await adapter.startTask({ prompt: 'start', mode: 'read_only' }, h.ctx);
      const sessionId = start.sessionId;
      if (sessionId === undefined) throw new Error('resume capable but startTask returned no sessionId');
      const h2 = makeRunContext({ cwd: workdir, policy: { approvals: 'never' } });
      const cont = await adapter.continueTask!({ sessionId, prompt: 'more' }, h2.ctx);
      assert(cont.status === 'completed', `continue expected completed, got ${cont.status}`);
    });

    await record('steering: steerTask defined', caps.steering, async () => {
      assert(typeof adapter.steerTask === 'function', 'steering capable but steerTask missing');
      await adapter.steerTask!('sess', 'focus on tests');
    });

    await record('approvals: elevated actions request approval', caps.approvals, async () => {
      const h = makeRunContext({
        cwd: workdir,
        policy: { mode: 'read_only', approvals: 'on_request' },
        approvalDecision: 'denied',
      });
      await adapter.startTask({ prompt: 'do a thing that needs approval', mode: 'read_only' }, h.ctx);
      assert(h.approvalRequests.length > 0, 'approvals capable but no approval was requested');
    });

    await record('cancellation: aborts promptly', caps.cancellation, async () => {
      const h = makeRunContext({ cwd: workdir, preAborted: true, policy: { approvals: 'never' } });
      const result = await adapter.startTask({ prompt: 'long task', mode: 'read_only' }, h.ctx);
      assert(result.status === 'cancelled', `expected cancelled, got ${result.status}`);
    });

    await record('write mode: produces a file change', caps.writeMode, async () => {
      const h = makeRunContext({
        cwd: workdir,
        policy: { mode: 'write', sandbox: 'workspace_write', approvals: 'never' },
      });
      await adapter.startTask({ prompt: 'write a file', mode: 'write' }, h.ctx);
      const changed = h.events.some((e) => e.type === 'file_changed');
      assert(changed, 'write-capable provider emitted no file_changed event');
    });
  } finally {
    await adapter.dispose?.();
    rmSync(workdir, { recursive: true, force: true });
  }

  const passed = checks.every((c) => c.status !== 'failed');
  const report: ConformanceReport = { provider: providerName, checks, passed };
  if (!passed && options.throwOnFailure !== false) throw conformanceError(report);
  return report;
};

const conformanceError = (report: ConformanceReport): Error => {
  const failed = report.checks.filter((c) => c.status === 'failed');
  return new Error(
    `Provider "${report.provider}" failed conformance:\n` +
      failed.map((c) => `  - ${c.name}: ${c.message ?? 'failed'}`).join('\n'),
  );
};
