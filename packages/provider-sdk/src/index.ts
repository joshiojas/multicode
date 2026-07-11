/**
 * `@multicode/provider-sdk` — the stable contract third-party and built-in providers implement, plus
 * capability negotiation, an isolation-aware registry/loader, and (under `./conformance`) the shared
 * suite every provider must pass.
 *
 * Import provider-facing pieces from the root; import the conformance suite from
 * `@multicode/provider-sdk/conformance` and the reference fake from `@multicode/provider-sdk/testing`.
 */
export type {
  ProviderAdapter,
  ProviderFactory,
  ProviderInit,
  ProviderRunContext,
  ProviderStartInput,
  ProviderContinueInput,
  ProviderTurnResult,
  ProviderApprovalRequest,
  ApprovalOutcome,
} from './adapter.js';
export { AuthStatus } from './adapter.js';

export { type ProviderEvent, providerEventToTaskEvent } from './events.js';

export {
  requiredFlagsForTask,
  negotiateStart,
  negotiateContinue,
  negotiateSteer,
  negotiateCancel,
  type TaskCapabilityNeeds,
} from './negotiate.js';

export {
  ProviderRegistry,
  resolveFactory,
  isSdkCompatible,
  type ProviderSource,
  type ProviderLoadSpec,
  type ProviderInfo,
  type ModuleImporter,
} from './registry.js';
