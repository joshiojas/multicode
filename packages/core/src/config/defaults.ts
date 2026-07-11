import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LIMITS } from '../domain/policy.js';
import type { MulticodeConfig, PolicyDefaults } from './schema.js';

/** Default data directory: `~/.multicode` (override with the `MULTICODE_HOME` env var). */
export const defaultDataDir = (env: NodeJS.ProcessEnv = process.env): string => {
  const home = env['MULTICODE_HOME'];
  return home && home.length > 0 ? home : join(homedir(), '.multicode');
};

export const defaultPolicyDefaults = (): PolicyDefaults => ({
  mode: 'read_only',
  sandbox: 'read_only',
  network: 'disabled',
  approvals: 'on_request',
  limits: { ...DEFAULT_LIMITS },
});

/**
 * A minimal, valid configuration used by `multicode init` and by tests. It has no workspace roots and
 * no providers configured — the user adds those explicitly, keeping the default posture locked down.
 */
export const defaultConfig = (env: NodeJS.ProcessEnv = process.env): MulticodeConfig => ({
  version: 1,
  dataDir: defaultDataDir(env),
  workspaceRoots: [],
  defaults: defaultPolicyDefaults(),
  providers: {},
  transport: { type: 'stdio' },
  logging: { level: 'info', pretty: false },
  telemetry: { enabled: false },
});

/** Standard sub-paths within the data directory. */
export const dataPaths = (dataDir: string) => ({
  root: dataDir,
  database: join(dataDir, 'multicode.db'),
  worktrees: join(dataDir, 'worktrees'),
  artifacts: join(dataDir, 'artifacts'),
  logs: join(dataDir, 'logs'),
  configFile: join(dataDir, 'config.json'),
});
export type DataPaths = ReturnType<typeof dataPaths>;
