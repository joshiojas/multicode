import { ProviderUnavailableError } from '@multicode/core';
import {
  ProviderRegistry,
  isSdkCompatible,
  resolveFactory,
  type ProviderFactory,
  type ProviderLoadSpec,
} from '@multicode/provider-sdk';
import { createProvider } from '@multicode/provider-sdk/testing';
import { describe, expect, it } from 'vitest';

const spec = (over: Partial<ProviderLoadSpec>): ProviderLoadSpec => ({
  id: 'fake',
  enabled: true,
  config: {},
  ...over,
});

describe('isSdkCompatible', () => {
  it('matches on the major version only', () => {
    expect(isSdkCompatible('1.0.0', '1.0.0')).toBe(true);
    expect(isSdkCompatible('1.9.3', '1.0.0')).toBe(true);
    expect(isSdkCompatible('2.0.0', '1.0.0')).toBe(false);
    expect(isSdkCompatible('garbage', '1.0.0')).toBe(false);
  });
});

describe('resolveFactory', () => {
  it('accepts createProvider or default exports', () => {
    expect(resolveFactory({ createProvider }, 'pkg')).toBe(createProvider);
    expect(resolveFactory({ default: createProvider }, 'pkg')).toBe(createProvider);
  });
  it('rejects a module without a factory', () => {
    expect(() => resolveFactory({}, 'pkg')).toThrow(/factory/);
  });
});

describe('ProviderRegistry', () => {
  it('loads a built-in provider and exposes its capabilities', async () => {
    const registry = new ProviderRegistry();
    registry.registerBuiltin('fake', createProvider);
    await registry.load([spec({ id: 'fake' })]);

    expect(registry.has('fake')).toBe(true);
    expect(registry.get('fake').descriptor.id).toBe('fake');
    expect(registry.capabilitiesOf('fake').writeMode).toBe(true);
    expect(registry.info('fake')?.status).toBe('ready');
  });

  it('records disabled providers without loading them', async () => {
    const registry = new ProviderRegistry();
    registry.registerBuiltin('fake', createProvider);
    await registry.load([spec({ id: 'fake', enabled: false })]);
    expect(registry.info('fake')?.status).toBe('disabled');
    expect(() => registry.get('fake')).toThrow(ProviderUnavailableError);
  });

  it('isolates a provider that throws during load without affecting others', async () => {
    const boom: ProviderFactory = () => {
      throw new Error('kaboom');
    };
    const registry = new ProviderRegistry();
    registry.registerBuiltin('bad', boom);
    registry.registerBuiltin('fake', createProvider);
    await registry.load([spec({ id: 'bad' }), spec({ id: 'fake' })]);

    expect(registry.info('bad')?.status).toBe('failed');
    expect(registry.info('bad')?.error?.message).toContain('kaboom');
    // The good provider still loaded.
    expect(registry.has('fake')).toBe(true);
    expect(() => registry.get('bad')).toThrow(ProviderUnavailableError);
  });

  it('loads a third-party package via the injected importer', async () => {
    const registry = new ProviderRegistry({
      importer: async (specifier) => {
        expect(specifier).toBe('@acme/multicode-provider');
        return { createProvider };
      },
    });
    await registry.load([spec({ id: 'acme', package: '@acme/multicode-provider' })]);
    expect(registry.info('acme')?.status).toBe('ready');
    expect(registry.info('acme')?.source).toBe('package');
  });

  it('fails a package provider with no package configured', async () => {
    const registry = new ProviderRegistry();
    await registry.load([spec({ id: 'nopkg' })]);
    expect(registry.info('nopkg')?.status).toBe('failed');
    expect(registry.info('nopkg')?.error?.message).toMatch(/not built in|no .*package/);
  });

  it('rejects an adapter built against an incompatible SDK contract', async () => {
    const wrongSdk: ProviderFactory = () => ({
      descriptor: {
        id: 'old',
        displayName: 'Old',
        version: '1.0.0',
        protocolVersion: 'x',
        sdkVersion: '2.0.0',
      },
      capabilities: async () => ({ readOnlyMode: true }) as never,
      authStatus: async () => ({ authenticated: false }),
      startTask: async () => ({ status: 'completed' as const }),
    });
    const registry = new ProviderRegistry();
    registry.registerBuiltin('old', wrongSdk);
    await registry.load([spec({ id: 'old' })]);
    expect(registry.info('old')?.status).toBe('failed');
    expect(registry.info('old')?.error?.message).toMatch(/SDK contract|incompatible/i);
  });

  it('markFailed isolates a provider at runtime', async () => {
    const registry = new ProviderRegistry();
    registry.registerBuiltin('fake', createProvider);
    await registry.load([spec({ id: 'fake' })]);
    registry.markFailed('fake', new Error('crashed'));
    expect(registry.info('fake')?.status).toBe('failed');
    expect(() => registry.get('fake')).toThrow(ProviderUnavailableError);
  });
});
