import {
  ConfigError,
  PROVIDER_SDK_CONTRACT_VERSION,
  ProviderCapabilities,
  ProviderDescriptor,
  ProviderUnavailableError,
  noopLogger,
  toMulticodeError,
  type Logger,
  type SerializedError,
} from '@multicode/core';
import type { ProviderAdapter, ProviderFactory, ProviderInit } from './adapter.js';

/** How a provider adapter was obtained. */
export type ProviderSource = 'builtin' | 'package';

export interface ProviderLoadSpec {
  readonly id: string;
  readonly enabled: boolean;
  /** For `package` providers: the npm package to import. */
  readonly package?: string | undefined;
  /** Pinned/expected version for a `package` provider (informational; validated best-effort). */
  readonly version?: string | undefined;
  readonly config: Record<string, unknown>;
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: Record<string, string> | undefined;
}

export interface ProviderInfo {
  readonly id: string;
  readonly source: ProviderSource;
  readonly status: 'ready' | 'failed' | 'disabled';
  readonly descriptor?: ProviderDescriptor;
  readonly capabilities?: ProviderCapabilities;
  readonly error?: SerializedError;
}

interface Entry {
  id: string;
  source: ProviderSource;
  status: 'ready' | 'failed' | 'disabled';
  adapter?: ProviderAdapter;
  descriptor?: ProviderDescriptor;
  capabilities?: ProviderCapabilities;
  error?: SerializedError;
}

/** A pluggable module importer, injected so the package-loading path is testable without real packages. */
export type ModuleImporter = (specifier: string) => Promise<unknown>;

const defaultImporter: ModuleImporter = (specifier) => import(specifier);

/** Compare the adapter's declared SDK contract version against this build's contract (major must match). */
export const isSdkCompatible = (adapterSdkVersion: string, contract = PROVIDER_SDK_CONTRACT_VERSION): boolean => {
  const major = (v: string): number => Number.parseInt(v.split('.')[0] ?? '', 10);
  const a = major(adapterSdkVersion);
  const c = major(contract);
  return Number.isInteger(a) && Number.isInteger(c) && a === c;
};

/** Resolve a provider factory from an imported module (`createProvider` or default export). */
export const resolveFactory = (mod: unknown, packageName: string): ProviderFactory => {
  const m = (mod ?? {}) as Record<string, unknown>;
  const candidate = m['createProvider'] ?? m['default'];
  if (typeof candidate !== 'function') {
    throw new ConfigError(
      `Provider package "${packageName}" must export a factory as \`createProvider\` or default`,
      { details: { packageName } },
    );
  }
  return candidate as ProviderFactory;
};

/**
 * Loads, validates, and isolates provider adapters.
 *
 * - Built-in providers are registered in-process by the server (keeping this package free of any
 *   concrete provider dependency).
 * - Third-party providers are explicitly configured with a `package` name, dynamically imported,
 *   validated against the SDK contract version, and — crucially — *isolated*: a provider that fails to
 *   load or validate is recorded as `failed` and never prevents other providers from loading. Calls to
 *   a failed provider raise {@link ProviderUnavailableError}.
 */
export class ProviderRegistry {
  readonly #builtins = new Map<string, ProviderFactory>();
  readonly #entries = new Map<string, Entry>();
  readonly #logger: Logger;
  readonly #importer: ModuleImporter;

  constructor(options: { logger?: Logger; importer?: ModuleImporter } = {}) {
    this.#logger = options.logger ?? noopLogger;
    this.#importer = options.importer ?? defaultImporter;
  }

  /** Register a built-in provider factory (called by the server for bundled providers like Codex). */
  registerBuiltin(id: string, factory: ProviderFactory): void {
    this.#builtins.set(id, factory);
  }

  /** Load every enabled provider spec, isolating failures. Never throws for a single bad provider. */
  async load(specs: readonly ProviderLoadSpec[]): Promise<void> {
    for (const spec of specs) {
      if (!spec.enabled) {
        this.#entries.set(spec.id, { id: spec.id, source: spec.package ? 'package' : 'builtin', status: 'disabled' });
        continue;
      }
      await this.#loadOne(spec);
    }
  }

  async #loadOne(spec: ProviderLoadSpec): Promise<void> {
    const source: ProviderSource = this.#builtins.has(spec.id) ? 'builtin' : 'package';
    try {
      const factory = await this.#resolveFactoryFor(spec, source);
      const init: ProviderInit = {
        id: spec.id,
        config: spec.config,
        ...(spec.command !== undefined ? { command: spec.command } : {}),
        ...(spec.args !== undefined ? { args: spec.args } : {}),
        ...(spec.env !== undefined ? { env: spec.env } : {}),
        logger: this.#logger.child({ provider: spec.id }),
      };
      const adapter = await factory(init);

      const descriptor = ProviderDescriptor.parse(adapter.descriptor);
      if (!isSdkCompatible(descriptor.sdkVersion)) {
        throw new ConfigError(
          `Provider "${spec.id}" targets SDK contract ${descriptor.sdkVersion}, incompatible with ${PROVIDER_SDK_CONTRACT_VERSION}`,
          { details: { provider: spec.id, adapterSdk: descriptor.sdkVersion, contract: PROVIDER_SDK_CONTRACT_VERSION } },
        );
      }
      const capabilities = ProviderCapabilities.parse(await adapter.capabilities());

      this.#entries.set(spec.id, { id: spec.id, source, status: 'ready', adapter, descriptor, capabilities });
      this.#logger.info({ provider: spec.id, source, version: descriptor.version }, 'provider loaded');
    } catch (err) {
      const error = toMulticodeError(err);
      this.#entries.set(spec.id, { id: spec.id, source, status: 'failed', error: error.toJSON() });
      this.#logger.error({ provider: spec.id, err: error.toJSON() }, 'provider failed to load');
    }
  }

  async #resolveFactoryFor(spec: ProviderLoadSpec, source: ProviderSource): Promise<ProviderFactory> {
    if (source === 'builtin') {
      const factory = this.#builtins.get(spec.id);
      if (!factory) throw new ConfigError(`No built-in provider registered for "${spec.id}"`);
      return factory;
    }
    if (!spec.package) {
      throw new ConfigError(
        `Provider "${spec.id}" is not built in and has no \`package\` configured`,
        { details: { provider: spec.id } },
      );
    }
    const mod = await this.#importer(spec.package);
    return resolveFactory(mod, spec.package);
  }

  /** Get a ready adapter or throw {@link ProviderUnavailableError}. */
  get(id: string): ProviderAdapter {
    const entry = this.#entries.get(id);
    if (!entry) throw new ProviderUnavailableError(`Provider "${id}" is not configured`, { details: { id } });
    if (entry.status !== 'ready' || !entry.adapter) {
      throw new ProviderUnavailableError(`Provider "${id}" is ${entry.status}`, {
        details: { id, status: entry.status, error: entry.error },
      });
    }
    return entry.adapter;
  }

  /** Cached capabilities for a ready provider. */
  capabilitiesOf(id: string): ProviderCapabilities {
    const entry = this.#entries.get(id);
    if (!entry?.capabilities) {
      throw new ProviderUnavailableError(`Provider "${id}" has no capabilities (status: ${entry?.status ?? 'unknown'})`);
    }
    return entry.capabilities;
  }

  has(id: string): boolean {
    return this.#entries.get(id)?.status === 'ready';
  }

  info(id: string): ProviderInfo | undefined {
    const e = this.#entries.get(id);
    if (!e) return undefined;
    return toInfo(e);
  }

  list(): ProviderInfo[] {
    return [...this.#entries.values()].map(toInfo);
  }

  /** Mark a provider unhealthy at runtime (e.g. after repeated crashes) so it is isolated. */
  markFailed(id: string, error: unknown): void {
    const e = this.#entries.get(id);
    const serialized = toMulticodeError(error).toJSON();
    if (e) {
      e.status = 'failed';
      delete e.adapter;
      e.error = serialized;
    }
  }

  async dispose(): Promise<void> {
    for (const entry of this.#entries.values()) {
      try {
        await entry.adapter?.dispose?.();
      } catch (err) {
        this.#logger.warn({ provider: entry.id, err: String(err) }, 'provider dispose failed');
      }
    }
  }
}

const toInfo = (e: Entry): ProviderInfo => ({
  id: e.id,
  source: e.source,
  status: e.status,
  ...(e.descriptor ? { descriptor: e.descriptor } : {}),
  ...(e.capabilities ? { capabilities: e.capabilities } : {}),
  ...(e.error ? { error: e.error } : {}),
});
