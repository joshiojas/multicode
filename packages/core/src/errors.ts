/**
 * Multicode's error taxonomy. Every failure that crosses a module boundary is a {@link MulticodeError}
 * with a stable machine-readable {@link ErrorCode}. The MCP tool layer maps these codes to protocol
 * errors and safe, structured payloads; nothing else should throw bare `Error`s across boundaries.
 */
export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'ILLEGAL_STATE_TRANSITION'
  | 'CAPABILITY_UNSUPPORTED'
  | 'SECURITY_VIOLATION'
  | 'WORKSPACE_INVALID'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'PERSISTENCE_ERROR'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'INTERNAL';

export interface MulticodeErrorOptions {
  /** Machine-readable, safe-to-serialize detail. Never include secrets. */
  readonly details?: Record<string, unknown>;
  /** Whether the caller can reasonably retry the same operation. */
  readonly retriable?: boolean;
  readonly cause?: unknown;
}

export interface SerializedError {
  readonly name: string;
  readonly code: ErrorCode;
  readonly message: string;
  readonly retriable: boolean;
  readonly details?: Record<string, unknown>;
}

/** Base class for all Multicode errors. */
export class MulticodeError extends Error {
  readonly code: ErrorCode;
  readonly retriable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, options: MulticodeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.retriable = options.retriable ?? false;
    this.details = options.details;
    // Preserve prototype chain across transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Serialize to a shape safe to send over MCP (no stack, no secrets). */
  toJSON(): SerializedError {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retriable: this.retriable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export class ConfigError extends MulticodeError {
  constructor(message: string, options?: MulticodeErrorOptions) {
    super('CONFIG_INVALID', message, options);
  }
}

export class ValidationError extends MulticodeError {
  constructor(message: string, options?: MulticodeErrorOptions) {
    super('VALIDATION_FAILED', message, options);
  }
}

export class NotFoundError extends MulticodeError {
  constructor(message: string, options?: MulticodeErrorOptions) {
    super('NOT_FOUND', message, options);
  }
}

export class ConflictError extends MulticodeError {
  constructor(message: string, options?: MulticodeErrorOptions) {
    super('CONFLICT', message, { retriable: true, ...options });
  }
}

export class StateTransitionError extends MulticodeError {
  constructor(message: string, options?: MulticodeErrorOptions) {
    super('ILLEGAL_STATE_TRANSITION', message, options);
  }
}

export class CapabilityError extends MulticodeError {
  constructor(message: string, options?: MulticodeErrorOptions) {
    super('CAPABILITY_UNSUPPORTED', message, options);
  }
}

export class SecurityError extends MulticodeError {
  constructor(message: string, options?: MulticodeErrorOptions) {
    super('SECURITY_VIOLATION', message, options);
  }
}

export class WorkspaceError extends MulticodeError {
  constructor(message: string, options?: MulticodeErrorOptions) {
    super('WORKSPACE_INVALID', message, options);
  }
}

export class ProviderError extends MulticodeError {
  constructor(message: string, options?: MulticodeErrorOptions) {
    super('PROVIDER_ERROR', message, options);
  }
}

export class ProviderUnavailableError extends MulticodeError {
  constructor(message: string, options?: MulticodeErrorOptions) {
    super('PROVIDER_UNAVAILABLE', message, { retriable: true, ...options });
  }
}

export class AuthRequiredError extends MulticodeError {
  constructor(message: string, options?: MulticodeErrorOptions) {
    super('AUTH_REQUIRED', message, options);
  }
}

export class TimeoutError extends MulticodeError {
  constructor(message: string, options?: MulticodeErrorOptions) {
    super('TIMEOUT', message, options);
  }
}

export class CancelledError extends MulticodeError {
  constructor(message: string, options?: MulticodeErrorOptions) {
    super('CANCELLED', message, options);
  }
}

export class PersistenceError extends MulticodeError {
  constructor(message: string, options?: MulticodeErrorOptions) {
    super('PERSISTENCE_ERROR', message, options);
  }
}

export class OutputLimitError extends MulticodeError {
  constructor(message: string, options?: MulticodeErrorOptions) {
    super('OUTPUT_LIMIT_EXCEEDED', message, options);
  }
}

/** Wrap an unknown thrown value as a {@link MulticodeError} without losing information. */
export const toMulticodeError = (value: unknown): MulticodeError => {
  if (value instanceof MulticodeError) return value;
  if (value instanceof Error) {
    return new MulticodeError('INTERNAL', value.message, { cause: value });
  }
  return new MulticodeError('INTERNAL', typeof value === 'string' ? value : 'Unknown error', {
    details: { value: safeStringify(value) },
  });
};

export const isMulticodeError = (value: unknown): value is MulticodeError =>
  value instanceof MulticodeError;

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};
