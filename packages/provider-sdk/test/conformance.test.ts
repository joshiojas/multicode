import { PROVIDER_SDK_CONTRACT_VERSION } from '@multicode/core';
import { runConformance } from '@multicode/provider-sdk/conformance';
import { createProvider } from '@multicode/provider-sdk/testing';
import type { ProviderAdapter, ProviderFactory } from '@multicode/provider-sdk';
import { describe, expect, it } from 'vitest';

describe('provider conformance suite', () => {
  it('the reference FakeProvider passes every applicable check', async () => {
    const report = await runConformance(createProvider);
    expect(report.passed).toBe(true);
    expect(report.checks.some((c) => c.status === 'failed')).toBe(false);
    // Sanity: the capability-gated checks actually ran (not all skipped).
    expect(report.checks.filter((c) => c.status === 'passed').length).toBeGreaterThan(5);
  });

  it('fails a provider that claims cancellation but ignores the abort signal', async () => {
    const liar: ProviderFactory = () => {
      const adapter: ProviderAdapter = {
        descriptor: {
          id: 'liar',
          displayName: 'Liar',
          version: '0.0.1',
          protocolVersion: 'x',
          sdkVersion: PROVIDER_SDK_CONTRACT_VERSION,
        },
        capabilities: async () => ({
          streaming: false,
          resume: false,
          steering: false,
          approvals: false,
          cancellation: true, // claims it…
          writeMode: false,
          readOnlyMode: true,
          artifacts: false,
          providerDiff: false,
          structuredResult: false,
          sandboxLevels: ['read_only'],
          networkControl: false,
          models: [],
        }),
        authStatus: async () => ({ authenticated: true }),
        // …but never honors the signal.
        startTask: async () => ({ status: 'completed' }),
      };
      return adapter;
    };

    const report = await runConformance(liar, { throwOnFailure: false });
    expect(report.passed).toBe(false);
    const cancel = report.checks.find((c) => c.name.startsWith('cancellation'));
    expect(cancel?.status).toBe('failed');
  });

  it('throws by default when a provider fails conformance', async () => {
    const broken: ProviderFactory = () => {
      throw new Error('cannot construct');
    };
    await expect(runConformance(broken)).rejects.toThrow(/conformance|construct/i);
  });
});
