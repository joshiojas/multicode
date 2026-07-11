import {
  CapabilityError,
  ExecutionPolicy,
  SecurityError,
  sandboxRank,
  supportsSandbox,
  type ExecutionLimits,
  type PolicyDefaults,
  type ProviderCapabilities,
  type TaskMode,
} from '@multicode/core';

/** A partial policy where each field may also be explicitly `undefined` (matches Zod `.partial()`). */
export type PolicyOverride = { [K in keyof ExecutionPolicy]?: ExecutionPolicy[K] | undefined };

export interface ResolvePolicyInput {
  readonly defaults: PolicyDefaults;
  /** Partial overrides from the task request. */
  readonly override?: PolicyOverride | undefined;
  /** Mode may be specified separately (from StartTaskInput); takes precedence over override/defaults. */
  readonly mode?: TaskMode | undefined;
}

/**
 * Resolve the effective {@link ExecutionPolicy} for a task from configured defaults plus task
 * overrides — with a hard rule: a write task can never run more restrictively than it needs, and can
 * never be silently escalated to a more permissive sandbox than the caller asked for.
 *
 * A `write` task requires at least `workspace_write`. If the caller explicitly asked for a `read_only`
 * sandbox on a write task, that is contradictory and rejected rather than silently escalated.
 */
export const resolveExecutionPolicy = (input: ResolvePolicyInput): ExecutionPolicy => {
  const { defaults, override } = input;
  const mode: TaskMode = input.mode ?? override?.mode ?? defaults.mode;
  const sandbox = override?.sandbox ?? defaults.sandbox;

  if (mode === 'write' && sandboxRank(sandbox) < sandboxRank('workspace_write')) {
    throw new SecurityError(
      'A write task requires a sandbox of at least "workspace_write"; ' +
        'refusing to silently escalate a read_only request.',
      { details: { mode, requestedSandbox: sandbox } },
    );
  }

  const limits: ExecutionLimits = override?.limits ?? defaults.limits;

  return ExecutionPolicy.parse({
    mode,
    sandbox,
    network: override?.network ?? defaults.network,
    approvals: override?.approvals ?? defaults.approvals,
    limits,
    extraReadRoots: override?.extraReadRoots ?? [],
    passthroughEnv: override?.passthroughEnv ?? [],
  });
};

/**
 * Assert a resolved policy can actually be *enforced* by a given provider. This is where "capability
 * negotiation instead of hardcoded provider checks" bites: a provider that cannot control the network
 * may not be handed a task that requires the network to be disabled.
 */
export const assertPolicyEnforceable = (
  policy: ExecutionPolicy,
  capabilities: ProviderCapabilities,
  providerId: string,
): void => {
  if (!supportsSandbox(capabilities, policy.sandbox)) {
    throw new CapabilityError(
      `Provider "${providerId}" cannot enforce sandbox level "${policy.sandbox}"`,
      { details: { providerId, requested: policy.sandbox, supported: capabilities.sandboxLevels } },
    );
  }
  if (policy.mode === 'write' && !capabilities.writeMode) {
    throw new CapabilityError(`Provider "${providerId}" does not support write mode`, {
      details: { providerId },
    });
  }
  if (policy.network !== 'enabled' && !capabilities.networkControl) {
    throw new CapabilityError(
      `Provider "${providerId}" cannot enforce a "${policy.network}" network policy`,
      { details: { providerId, network: policy.network } },
    );
  }
};
