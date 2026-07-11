import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, MulticodeConfig, dataPaths } from '@multicode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configExists,
  loadConfig,
  resolveConfigPath,
  saveConfig,
  starterConfig,
} from '../src/config-loader.js';

describe('config loader', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mc-cli-cfg-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('starterConfig is valid and uses the given data dir', () => {
    const cfg = starterConfig('/repo', { dataDir: dir });
    expect(cfg.dataDir).toBe(dir);
    expect(cfg.workspaceRoots).toEqual(['/repo']);
    expect(cfg.providers['codex']?.enabled).toBe(true);
    expect(() => MulticodeConfig.parse(cfg)).not.toThrow();
  });

  it('resolves the config path from the data dir', () => {
    expect(resolveConfigPath({ dataDir: dir })).toBe(dataPaths(dir).configFile);
  });

  it('saves and loads a config round-trip', () => {
    const path = dataPaths(dir).configFile;
    const cfg = starterConfig('/repo', { dataDir: dir });
    expect(configExists(path)).toBe(false);
    saveConfig(path, cfg);
    expect(configExists(path)).toBe(true);
    const loaded = loadConfig({ dataDir: dir });
    expect(loaded.dataDir).toBe(dir);
    expect(loaded.workspaceRoots).toEqual(['/repo']);
  });

  it('throws a helpful error when the config is missing', () => {
    expect(() => loadConfig({ dataDir: dir })).toThrow(ConfigError);
    expect(() => loadConfig({ dataDir: dir })).toThrow(/multicode init/);
  });

  it('applies a data-dir override on load', () => {
    const path = dataPaths(dir).configFile;
    saveConfig(path, starterConfig('/repo', { dataDir: dir }));
    const override = join(dir, 'elsewhere');
    const loaded = loadConfig({ dataDir: dir, config: path } as never);
    expect(loaded.dataDir).toBe(dir);
    const loaded2 = loadConfig({ config: path, dataDir: override });
    expect(loaded2.dataDir).toBe(override);
  });
});
