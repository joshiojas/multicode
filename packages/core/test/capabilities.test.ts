import { describe, expect, it } from 'vitest';
import {
  CapabilityError,
  ProviderCapabilities,
  requireCapabilities,
  supportsSandbox,
} from '@multicode/core';

const caps = (over: Partial<ProviderCapabilities> = {}): ProviderCapabilities =>
  ProviderCapabilities.parse({
    streaming: true,
    resume: true,
    steering: false,
    approvals: true,
    cancellation: true,
    writeMode: true,
    readOnlyMode: true,
    sandboxLevels: ['read_only', 'workspace_write'],
    ...over,
  });

describe('capability negotiation', () => {
  it('fills conservative defaults for unspecified flags', () => {
    const parsed = ProviderCapabilities.parse({});
    expect(parsed.streaming).toBe(false);
    expect(parsed.readOnlyMode).toBe(true);
    expect(parsed.sandboxLevels).toEqual(['read_only']);
  });

  it('passes when all required capabilities are present', () => {
    expect(() => requireCapabilities(caps(), ['resume', 'writeMode'], 'codex')).not.toThrow();
  });

  it('throws listing the missing capabilities', () => {
    try {
      requireCapabilities(caps({ steering: false }), ['steering'], 'codex');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityError);
      expect((err as CapabilityError).details).toMatchObject({
        providerId: 'codex',
        missing: ['steering'],
      });
    }
  });

  it('checks sandbox levels', () => {
    expect(supportsSandbox(caps(), 'workspace_write')).toBe(true);
    expect(supportsSandbox(caps(), 'danger_full_access')).toBe(false);
  });
});
