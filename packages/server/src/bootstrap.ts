import { dataPaths, noopLogger, type Clock, type Logger, type MulticodeConfig } from '@multicode/core';
import { SqliteStore, type Store } from '@multicode/persistence';
import { WorkspaceGuard, WorktreeManager } from '@multicode/security';
import { type ProviderRegistry, type ProviderLoadSpec } from '@multicode/provider-sdk';
import { Orchestrator } from './orchestrator/orchestrator.js';

export interface BootstrapOptions {
  readonly config: MulticodeConfig;
  /** A registry with built-in providers already registered (the composition root wires providers). */
  readonly registry: ProviderRegistry;
  readonly logger?: Logger;
  readonly clock?: Clock;
  /** Skip loading providers (caller will call registry.load itself). */
  readonly skipProviderLoad?: boolean;
}

export interface BootstrapResult {
  readonly store: Store;
  readonly orchestrator: Orchestrator;
  readonly guard: WorkspaceGuard;
  readonly worktrees: WorktreeManager;
}

/**
 * Translate configured providers into loader specs, resolving each provider's non-secret passthrough
 * environment values from the current process environment (secrets never live in config).
 */
export const providerSpecsFromConfig = (config: MulticodeConfig): ProviderLoadSpec[] =>
  Object.entries(config.providers).map(([id, cfg]) => {
    const env: Record<string, string> = {};
    for (const name of cfg.passthroughEnv) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    return {
      id,
      enabled: cfg.enabled,
      package: cfg.package,
      version: cfg.version,
      config: cfg.config,
      command: cfg.command,
      args: cfg.args,
      env,
    };
  });

/**
 * Build the full runtime from configuration: durable store (migrated), workspace guard, worktree
 * manager, and orchestrator. Providers are loaded from config unless `skipProviderLoad` is set.
 */
export const bootstrap = async (options: BootstrapOptions): Promise<BootstrapResult> => {
  const { config, registry } = options;
  const logger = options.logger ?? noopLogger;
  const paths = dataPaths(config.dataDir);

  const store = await SqliteStore.open({
    path: paths.database,
    ...(options.clock ? { clock: options.clock } : {}),
  });

  if (!options.skipProviderLoad) {
    await registry.load(providerSpecsFromConfig(config));
  }

  const guard = WorkspaceGuard.fromRoots(config.workspaceRoots);
  const worktrees = new WorktreeManager(paths.worktrees);
  const orchestrator = new Orchestrator({
    store,
    registry,
    guard,
    worktrees,
    config,
    logger,
    ...(options.clock ? { clock: options.clock } : {}),
  });

  return { store, orchestrator, guard, worktrees };
};
