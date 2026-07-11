import {
  ProviderCapabilities,
  ProviderDescriptor,
  noopLogger,
} from '@multicode/core';
import { isSdkCompatible } from '@multicode/provider-sdk';
import { OllamaProvider, createProvider, extractJson } from '@multicode/provider-ollama';
import { describe, expect, it } from 'vitest';

describe('OllamaProvider (CI-safe: no server required)', () => {
  const provider = new OllamaProvider({ config: { model: 'gemma4:latest' }, logger: noopLogger });

  it('has a valid, SDK-compatible descriptor', () => {
    const desc = ProviderDescriptor.parse(provider.descriptor);
    expect(desc.id).toBe('ollama');
    expect(isSdkCompatible(desc.sdkVersion)).toBe(true);
  });

  it('declares valid, honest capabilities', async () => {
    const caps = ProviderCapabilities.parse(await provider.capabilities());
    expect(caps.writeMode).toBe(true);
    expect(caps.readOnlyMode).toBe(true);
    expect(caps.cancellation).toBe(true);
    // This adapter runs no untrusted shell commands and does not raise approvals.
    expect(caps.approvals).toBe(false);
    expect(caps.steering).toBe(false);
    expect(caps.models).toContain('gemma4:latest');
  });

  it('reports auth status without throwing and never exposes a token', async () => {
    const status = await provider.authStatus();
    expect(typeof status.authenticated).toBe('boolean');
    for (const key of Object.keys(status)) {
      expect(['token', 'secret', 'apikey', 'password']).not.toContain(key.toLowerCase());
    }
  });

  it('the factory constructs an OllamaProvider', () => {
    expect(createProvider({ id: 'ollama', config: {}, logger: noopLogger })).toBeInstanceOf(
      OllamaProvider,
    );
  });
});

describe('extractJson (small-model output tolerance)', () => {
  it('passes through clean JSON', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });
  it('strips ```json fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('strips bare ``` fences', () => {
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('extracts JSON embedded in prose', () => {
    expect(extractJson('Here is the result: {"a":1} Hope that helps!')).toBe('{"a":1}');
  });
});
