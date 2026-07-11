import { z } from 'zod';
import { CapabilityError } from '../errors.js';
import { SandboxLevel } from './policy.js';

/**
 * What a provider can do. Multicode negotiates against this instead of branching on provider names,
 * so a new provider only has to declare its capabilities honestly.
 *
 * Booleans default to the conservative value (`false`) so an under-specified provider is treated as
 * minimally capable rather than accidentally granted a feature it does not support.
 */
export const ProviderCapabilities = z
  .object({
    /** Emits incremental events during a turn (vs. only a final result). */
    streaming: z.boolean().default(false),
    /** Supports `continue_task` on an existing session. */
    resume: z.boolean().default(false),
    /** Accepts mid-flight steering messages without restarting the turn. */
    steering: z.boolean().default(false),
    /** Can raise approval requests for elevated actions. */
    approvals: z.boolean().default(false),
    /** Supports cooperative cancellation of an in-flight turn. */
    cancellation: z.boolean().default(false),
    /** Can make file modifications (write mode). */
    writeMode: z.boolean().default(false),
    /** Can run read-only over a workspace. */
    readOnlyMode: z.boolean().default(true),
    /** Produces named artifacts beyond the diff. */
    artifacts: z.boolean().default(false),
    /** Can itself report a diff. When false, Multicode derives the diff from Git directly. */
    providerDiff: z.boolean().default(false),
    /** Returns a machine-readable structured result. */
    structuredResult: z.boolean().default(false),
    /** Sandbox levels the provider can enforce. */
    sandboxLevels: z.array(SandboxLevel).default(['read_only']),
    /** Can constrain network access. */
    networkControl: z.boolean().default(false),
    /** Models the provider advertises, if any. */
    models: z.array(z.string()).default([]),
    /** Maximum tasks the provider can run at once (undefined = unbounded by the provider). */
    maxConcurrentTasks: z.number().int().positive().optional(),
  })
  .strict();
export type ProviderCapabilities = z.infer<typeof ProviderCapabilities>;

/** Static identity of a provider adapter. */
export const ProviderDescriptor = z
  .object({
    id: z.string(),
    displayName: z.string(),
    /** Adapter package version (semver). */
    version: z.string(),
    /** Version of the underlying provider protocol the adapter targets. */
    protocolVersion: z.string(),
    /** Version of the Multicode provider-SDK contract the adapter was built against. */
    sdkVersion: z.string(),
  })
  .strict();
export type ProviderDescriptor = z.infer<typeof ProviderDescriptor>;

/** The capability keys a caller can require when starting a task. */
export type CapabilityFlag = Extract<
  keyof ProviderCapabilities,
  | 'streaming'
  | 'resume'
  | 'steering'
  | 'approvals'
  | 'cancellation'
  | 'writeMode'
  | 'readOnlyMode'
  | 'artifacts'
  | 'providerDiff'
  | 'structuredResult'
  | 'networkControl'
>;

/**
 * Assert that a provider supports every flag in `required`. Throws {@link CapabilityError} listing the
 * unmet flags. This is the single choke point that keeps provider-specific `if` branches out of the
 * orchestrator.
 */
export const requireCapabilities = (
  caps: ProviderCapabilities,
  required: readonly CapabilityFlag[],
  providerId: string,
): void => {
  const missing = required.filter((flag) => caps[flag] !== true);
  if (missing.length > 0) {
    throw new CapabilityError(
      `Provider "${providerId}" does not support required capabilities: ${missing.join(', ')}`,
      { details: { providerId, missing } },
    );
  }
};

/** True if `caps` can enforce at least the requested sandbox level. */
export const supportsSandbox = (caps: ProviderCapabilities, level: SandboxLevel): boolean =>
  caps.sandboxLevels.includes(level);
