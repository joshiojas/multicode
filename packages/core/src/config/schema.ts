import { z } from 'zod';
import { isValidProviderId } from '../ids.js';
import {
  ApprovalPolicy,
  ExecutionLimits,
  NetworkPolicy,
  SandboxLevel,
  TaskMode,
} from '../domain/policy.js';

/** Structured logging configuration. */
export const LoggingConfig = z
  .object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    /** Pretty-print for humans (dev). Off by default so stdio transport stays clean JSON on stderr. */
    pretty: z.boolean().default(false),
    /** When set, also write structured logs to this file. Never write logs to stdout. */
    file: z.string().optional(),
  })
  .strict();
export type LoggingConfig = z.infer<typeof LoggingConfig>;

/** Per-provider configuration. Secrets are never stored here — see `docs/security.md`. */
export const ProviderConfig = z
  .object({
    enabled: z.boolean().default(true),
    /**
     * npm package implementing the adapter. Required for third-party providers; built-in providers
     * (e.g. `codex`) may omit it and are resolved from the bundled set.
     */
    package: z.string().optional(),
    /** Pinned adapter version for third-party providers (semver range). */
    version: z.string().optional(),
    /** Launch command for process-based providers (e.g. the Codex App Server). */
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    /**
     * Non-secret environment variable names to forward to the provider process. Values are read from
     * the current environment at spawn time; secrets must never be inlined into config.
     */
    passthroughEnv: z.array(z.string()).default([]),
    /** Adapter-specific configuration, validated by the adapter's own schema. */
    config: z.record(z.unknown()).default({}),
  })
  .strict();
export type ProviderConfig = z.infer<typeof ProviderConfig>;

/** Default execution policy applied when a task does not override a field. */
export const PolicyDefaults = z
  .object({
    mode: TaskMode.default('read_only'),
    sandbox: SandboxLevel.default('read_only'),
    network: NetworkPolicy.default('disabled'),
    approvals: ApprovalPolicy.default('on_request'),
    limits: ExecutionLimits,
  })
  .strict();
export type PolicyDefaults = z.infer<typeof PolicyDefaults>;

const StdioTransport = z.object({ type: z.literal('stdio') }).strict();

const HttpTransport = z
  .object({
    type: z.literal('http'),
    /** Bind address. Defaults to loopback; binding to a public interface requires an auth token. */
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(7461),
    path: z.string().default('/mcp'),
    /** Name of the env var holding the bearer token clients must present. */
    authTokenEnv: z.string().optional(),
    /** Allowed `Origin` values for browser clients (DNS-rebinding protection). */
    allowedOrigins: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((t, ctx) => {
    const isLoopback = t.host === '127.0.0.1' || t.host === '::1' || t.host === 'localhost';
    if (!isLoopback && !t.authTokenEnv) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'HTTP transport bound to a non-loopback host must set authTokenEnv.',
        path: ['authTokenEnv'],
      });
    }
  });

export const TransportConfig = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stdio') }).strict(),
  z.object({
    type: z.literal('http'),
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(7461),
    path: z.string().default('/mcp'),
    authTokenEnv: z.string().optional(),
    allowedOrigins: z.array(z.string()).default([]),
  }),
]);
export type TransportConfig = z.infer<typeof TransportConfig>;

// Re-export the refined variants for callers that validate a single transport object.
export const StdioTransportConfig = StdioTransport;
export const HttpTransportConfig = HttpTransport;

/** The complete, validated Multicode configuration. */
export const MulticodeConfig = z
  .object({
    /** Config schema version, for forward migration of the config file itself. */
    version: z.literal(1).default(1),
    /** Directory holding the SQLite database, worktrees, and artifact storage. */
    dataDir: z.string(),
    /**
     * Absolute paths a task may be rooted in. A task's `workspaceRoot` must be exactly one of these
     * (or a descendant, subject to validation). Empty means no task can run until configured.
     */
    workspaceRoots: z.array(z.string()).default([]),
    defaults: PolicyDefaults,
    providers: z
      .record(z.string(), ProviderConfig)
      .default({})
      .superRefine((providers, ctx) => {
        for (const id of Object.keys(providers)) {
          if (!isValidProviderId(id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Invalid provider id "${id}" (must be lowercase alphanumeric/hyphen).`,
              path: [id],
            });
          }
        }
      }),
    transport: TransportConfig.default({ type: 'stdio' }),
    logging: LoggingConfig.default({ level: 'info', pretty: false }),
    /** Local-first: telemetry is off unless a user explicitly enables it. */
    telemetry: z.object({ enabled: z.boolean().default(false) }).strict().default({ enabled: false }),
  })
  .strict();
export type MulticodeConfig = z.infer<typeof MulticodeConfig>;
