import {
  CapabilityError,
  ProviderCapabilities,
  SecurityError,
  defaultPolicyDefaults,
  type PolicyDefaults,
} from '@multicode/core';
import { describe, expect, it } from 'vitest';
import { assertPolicyEnforceable, resolveExecutionPolicy } from '@multicode/security';

const defaults: PolicyDefaults = defaultPolicyDefaults();

describe('resolveExecutionPolicy', () => {
  it('returns locked-down defaults for a read-only task', () => {
    const policy = resolveExecutionPolicy({ defaults });
    expect(policy.mode).toBe('read_only');
    expect(policy.sandbox).toBe('read_only');
    expect(policy.network).toBe('disabled');
  });

  it('rejects a write task with a read_only sandbox (no silent escalation)', () => {
    expect(() =>
      resolveExecutionPolicy({ defaults, mode: 'write', override: { sandbox: 'read_only' } }),
    ).toThrow(SecurityError);
  });

  it('permits a write task with workspace_write', () => {
    const policy = resolveExecutionPolicy({
      defaults,
      mode: 'write',
      override: { sandbox: 'workspace_write' },
    });
    expect(policy.mode).toBe('write');
    expect(policy.sandbox).toBe('workspace_write');
  });

  it('honors explicit overrides', () => {
    const policy = resolveExecutionPolicy({
      defaults,
      override: { network: 'enabled', approvals: 'auto' },
    });
    expect(policy.network).toBe('enabled');
    expect(policy.approvals).toBe('auto');
  });
});

describe('assertPolicyEnforceable', () => {
  const caps = (over: Partial<ProviderCapabilities> = {}) =>
    ProviderCapabilities.parse({
      writeMode: true,
      networkControl: true,
      sandboxLevels: ['read_only', 'workspace_write'],
      ...over,
    });

  it('passes when the provider can enforce the policy', () => {
    const policy = resolveExecutionPolicy({ defaults });
    expect(() => assertPolicyEnforceable(policy, caps(), 'codex')).not.toThrow();
  });

  it('rejects an unsupported sandbox level', () => {
    const policy = resolveExecutionPolicy({
      defaults,
      mode: 'write',
      override: { sandbox: 'danger_full_access' },
    });
    expect(() => assertPolicyEnforceable(policy, caps(), 'codex')).toThrow(CapabilityError);
  });

  it('rejects write mode when the provider cannot write', () => {
    const policy = resolveExecutionPolicy({
      defaults,
      mode: 'write',
      override: { sandbox: 'workspace_write' },
    });
    expect(() => assertPolicyEnforceable(policy, caps({ writeMode: false }), 'codex')).toThrow(
      CapabilityError,
    );
  });

  it('rejects a network restriction the provider cannot enforce', () => {
    const policy = resolveExecutionPolicy({ defaults }); // network disabled
    expect(() => assertPolicyEnforceable(policy, caps({ networkControl: false }), 'codex')).toThrow(
      CapabilityError,
    );
  });
});
