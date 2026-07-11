import { describe, expect, it } from 'vitest';
import {
  HttpTransportConfig,
  MulticodeConfig,
  dataPaths,
  defaultConfig,
} from '@multicode/core';

describe('MulticodeConfig', () => {
  it('parses a minimal config and applies defaults', () => {
    const cfg = MulticodeConfig.parse({ dataDir: '/data', defaults: { limits: limits() } });
    expect(cfg.version).toBe(1);
    expect(cfg.transport).toEqual({ type: 'stdio' });
    expect(cfg.logging.level).toBe('info');
    expect(cfg.telemetry.enabled).toBe(false);
    expect(cfg.workspaceRoots).toEqual([]);
  });

  it('rejects unknown top-level keys (strict)', () => {
    expect(() =>
      MulticodeConfig.parse({ dataDir: '/data', defaults: { limits: limits() }, bogus: 1 }),
    ).toThrow();
  });

  it('rejects invalid provider ids', () => {
    expect(() =>
      MulticodeConfig.parse({
        dataDir: '/data',
        defaults: { limits: limits() },
        providers: { 'Bad Id': { enabled: true } },
      }),
    ).toThrow(/Invalid provider id/);
  });

  it('defaultConfig round-trips through the schema', () => {
    const cfg = defaultConfig({ MULTICODE_HOME: '/tmp/mc' } as NodeJS.ProcessEnv);
    expect(cfg.dataDir).toBe('/tmp/mc');
    expect(() => MulticodeConfig.parse(cfg)).not.toThrow();
  });

  it('derives standard data paths', () => {
    const p = dataPaths('/data');
    expect(p.database).toBe('/data/multicode.db');
    expect(p.worktrees).toBe('/data/worktrees');
  });

  describe('HTTP transport hardening', () => {
    it('allows loopback with no auth token', () => {
      expect(() => HttpTransportConfig.parse({ type: 'http', host: '127.0.0.1' })).not.toThrow();
    });

    it('requires an auth token when bound to a non-loopback host', () => {
      expect(() => HttpTransportConfig.parse({ type: 'http', host: '0.0.0.0' })).toThrow(
        /authTokenEnv/,
      );
      expect(() =>
        HttpTransportConfig.parse({ type: 'http', host: '0.0.0.0', authTokenEnv: 'MC_TOKEN' }),
      ).not.toThrow();
    });
  });
});

const limits = () => ({
  timeoutMs: 60_000,
  cancelGraceMs: 5_000,
  maxOutputBytes: 1_000_000,
  maxEvents: 10_000,
});
