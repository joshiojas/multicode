import { z } from 'zod';
import type {
  ApprovalDecision,
  ApprovalKind,
  ExecutionPolicy,
  Logger,
  ProviderCapabilities,
  ProviderDescriptor,
  TaskId,
  TaskMode,
  TokenUsage,
} from '@multicode/core';
import type { ProviderEvent } from './events.js';

/**
 * Authentication status for a provider. Multicode reads *status only* — it must never receive, copy,
 * or persist a subscription token. Adapters obtain this by asking the provider's own login state.
 */
export const AuthStatus = z
  .object({
    authenticated: z.boolean(),
    /** Login method in use (e.g. `chatgpt`, `api_key`, `device_code`). Informational only. */
    method: z.string().optional(),
    /** Human-readable account label (e.g. an email or plan name) — never a credential. */
    account: z.string().optional(),
    /** When the current session/login expires, if known. */
    expiresAt: z.string().optional(),
    /** Non-secret detail for diagnostics. */
    detail: z.string().optional(),
  })
  .strict();
export type AuthStatus = z.infer<typeof AuthStatus>;

/** A provider's request for approval of an elevated action, raised mid-turn. */
export interface ProviderApprovalRequest {
  readonly kind: ApprovalKind;
  readonly summary: string;
  readonly detail?: Record<string, unknown>;
  /** Opaque token the adapter uses to correlate the decision back to its protocol. */
  readonly providerToken: string;
}

export interface ApprovalOutcome {
  readonly decision: ApprovalDecision;
  readonly note?: string;
}

/**
 * The context handed to an adapter for a single turn. It carries the confined workspace, the resolved
 * policy, a cancellation signal, and the two channels back to the orchestrator: `emit` (fire-and-forget
 * events) and `requestApproval` (await a human/policy decision).
 */
export interface ProviderRunContext {
  readonly taskId: TaskId;
  /** The directory the provider should operate in (worktree for write tasks, root for read-only). */
  readonly workspace: { readonly root: string; readonly cwd: string; readonly isGitRepo: boolean };
  readonly policy: ExecutionPolicy;
  /** Aborted when the task is cancelled or times out; adapters must stop promptly. */
  readonly signal: AbortSignal;
  readonly logger: Logger;
  /** Push a streamed event to the durable log. Must be safe to call frequently. */
  emit(event: ProviderEvent): void;
  /** Ask for approval and await the decision. Rejects if the task is cancelled while waiting. */
  requestApproval(request: ProviderApprovalRequest): Promise<ApprovalOutcome>;
}

/** Turn-specific input for a fresh task. Run-invariant data lives on {@link ProviderRunContext}. */
export interface ProviderStartInput {
  readonly prompt: string;
  readonly mode: TaskMode;
  /** Requested model, if the provider advertises models. */
  readonly model?: string;
}

/** Input to continue an existing, resumable session with a follow-up message. */
export interface ProviderContinueInput {
  readonly sessionId: string;
  readonly prompt: string;
  readonly model?: string;
}

/** The outcome of a single provider turn. The orchestrator derives the *verified* result separately. */
export interface ProviderTurnResult {
  readonly status: 'completed' | 'failed' | 'cancelled';
  /** The provider's own natural-language summary (untrusted narrative). */
  readonly summary?: string;
  /** Provider-validated structured payload, if any. */
  readonly structuredOutput?: Record<string, unknown>;
  /** Session id enabling resume/continue; set when the provider is resumable. */
  readonly sessionId?: string;
  readonly tokenUsage?: TokenUsage;
  /** Failure detail when `status === 'failed'`. */
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * The stable contract a provider adapter implements. New providers only implement this interface and
 * declare honest {@link ProviderCapabilities}; the orchestrator negotiates against those capabilities
 * rather than branching on provider identity.
 *
 * Optional methods correspond to optional capabilities — an adapter without `resume` capability need
 * not implement {@link continueTask}. The conformance suite enforces this correspondence.
 */
export interface ProviderAdapter {
  /** Static identity and version information. */
  readonly descriptor: ProviderDescriptor;

  /** Report capabilities. May probe the provider; should be cached by the adapter if expensive. */
  capabilities(): Promise<ProviderCapabilities>;

  /** Report login status without ever exposing a credential. */
  authStatus(): Promise<AuthStatus>;

  /** Run a fresh task turn. Resolves when the turn ends; streams via `ctx.emit` meanwhile. */
  startTask(input: ProviderStartInput, ctx: ProviderRunContext): Promise<ProviderTurnResult>;

  /** Continue a resumable session (present iff `capabilities.resume`). */
  continueTask?(input: ProviderContinueInput, ctx: ProviderRunContext): Promise<ProviderTurnResult>;

  /** Inject mid-flight guidance without a new turn (present iff `capabilities.steering`). */
  steerTask?(sessionId: string, message: string): Promise<void>;

  /** Release any long-lived resources (child processes, sockets). */
  dispose?(): Promise<void>;
}

/**
 * A factory that constructs an adapter from validated, adapter-specific configuration. Provider
 * packages export one of these as their default export or as `createProvider`.
 */
export type ProviderFactory = (init: ProviderInit) => ProviderAdapter | Promise<ProviderAdapter>;

export interface ProviderInit {
  /** The provider id under which this adapter is configured. */
  readonly id: string;
  /** Adapter-specific configuration (already parsed from the config file). */
  readonly config: Record<string, unknown>;
  /** Launch command/args for process-based providers. */
  readonly command?: string;
  readonly args?: readonly string[];
  /** Non-secret environment values resolved from the configured passthrough allow-list. */
  readonly env?: Record<string, string>;
  readonly logger: Logger;
}
