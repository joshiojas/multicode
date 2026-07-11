import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ConfigError,
  MulticodeConfig,
  dataPaths,
  defaultConfig,
  defaultDataDir,
  type Logger,
} from '@multicode/core';
import { ProviderRegistry } from '@multicode/provider-sdk';
import { createProvider as createCodexProvider } from '@multicode/provider-codex';
import { createProvider as createOllamaProvider } from '@multicode/provider-ollama';

export interface GlobalOptions {
  readonly config?: string;
  readonly dataDir?: string;
}

/** Resolve the config file path from flags/env (defaults to `<dataDir>/config.json`). */
export const resolveConfigPath = (opts: GlobalOptions, env = process.env): string => {
  if (opts.config) return opts.config;
  const dataDir = opts.dataDir ?? defaultDataDir(env);
  return dataPaths(dataDir).configFile;
};

export const configExists = (path: string): boolean => existsSync(path);

/** Load and validate the config file, applying flag overrides. */
export const loadConfig = (opts: GlobalOptions, env = process.env): MulticodeConfig => {
  const path = resolveConfigPath(opts, env);
  if (!existsSync(path)) {
    throw new ConfigError(
      `No Multicode config found at ${path}. Run \`multicode init\` first.`,
      { details: { path } },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new ConfigError(`Config at ${path} is not valid JSON`, { cause });
  }
  const parsed = MulticodeConfig.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Config at ${path} failed validation`, {
      details: { issues: parsed.error.issues },
    });
  }
  const config = parsed.data;
  return opts.dataDir ? { ...config, dataDir: opts.dataDir } : config;
};

/** Persist a config as pretty JSON, creating the directory if needed. */
export const saveConfig = (path: string, config: MulticodeConfig): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
};

/** Build a starter config: current directory as a workspace root, Codex enabled. */
export const starterConfig = (
  cwd: string,
  opts: { dataDir?: string; env?: NodeJS.ProcessEnv } = {},
): MulticodeConfig => {
  const env = opts.env ?? process.env;
  const base = defaultConfig(env);
  return {
    ...base,
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
    workspaceRoots: [cwd],
    providers: {
      codex: { enabled: true, args: ['app-server'], passthroughEnv: ['PATH', 'HOME', 'CODEX_HOME'], config: {} },
    },
  };
};

/**
 * Construct a provider registry with the built-in providers registered. This is the composition root
 * where concrete providers are bound; the server and core never import a provider directly.
 */
export const createRegistry = (logger: Logger): ProviderRegistry => {
  const registry = new ProviderRegistry({ logger });
  registry.registerBuiltin('codex', createCodexProvider);
  registry.registerBuiltin('ollama', createOllamaProvider);
  return registry;
};
