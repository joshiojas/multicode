import {
  requireCapabilities,
  type CapabilityFlag,
  type ProviderCapabilities,
  type TaskMode,
} from '@multicode/core';

export interface TaskCapabilityNeeds {
  readonly mode: TaskMode;
  /** The caller requires incremental streaming. */
  readonly requireStreaming?: boolean;
  /** The caller requires the provider to raise approvals for elevated actions. */
  readonly requireApprovals?: boolean;
}

/** Map a task's needs to the concrete capability flags a provider must have. */
export const requiredFlagsForTask = (needs: TaskCapabilityNeeds): CapabilityFlag[] => {
  const flags: CapabilityFlag[] = [needs.mode === 'write' ? 'writeMode' : 'readOnlyMode'];
  if (needs.requireStreaming) flags.push('streaming');
  if (needs.requireApprovals) flags.push('approvals');
  return flags;
};

/** Assert a provider can serve a fresh task with the given needs. */
export const negotiateStart = (
  caps: ProviderCapabilities,
  needs: TaskCapabilityNeeds,
  providerId: string,
): void => {
  requireCapabilities(caps, requiredFlagsForTask(needs), providerId);
};

/** Assert a provider supports continuing a resumable session. */
export const negotiateContinue = (caps: ProviderCapabilities, providerId: string): void => {
  requireCapabilities(caps, ['resume'], providerId);
};

/** Assert a provider supports mid-flight steering. */
export const negotiateSteer = (caps: ProviderCapabilities, providerId: string): void => {
  requireCapabilities(caps, ['steering'], providerId);
};

/** Assert a provider supports cooperative cancellation. */
export const negotiateCancel = (caps: ProviderCapabilities, providerId: string): void => {
  requireCapabilities(caps, ['cancellation'], providerId);
};
