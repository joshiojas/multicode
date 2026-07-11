/**
 * `@multicode/core` — the provider-neutral heart of Multicode.
 *
 * Nothing in this package imports a provider, a transport, or a persistence engine. It defines the
 * domain: identifiers, the task lifecycle and its state machine, the event model, execution policy,
 * provider capabilities, structured results with independent verification, approvals, artifacts,
 * configuration, and the shared error taxonomy.
 */

// Primitives
export * from './ids.js';
export * from './time.js';
export * from './logging.js';
export * from './errors.js';

// Domain
export * from './domain/status.js';
export * from './domain/policy.js';
export * from './domain/capabilities.js';
export * from './domain/approvals.js';
export * from './domain/artifacts.js';
export * from './domain/result.js';
export * from './domain/events.js';
export * from './domain/task.js';

// Configuration
export * from './config/schema.js';
export * from './config/defaults.js';

// Utilities
export * from './util/assert.js';

/** The version of the Multicode provider-SDK contract shipped by this core build. */
export const CORE_VERSION = '0.1.0';
export const PROVIDER_SDK_CONTRACT_VERSION = '1.0.0';
