import { randomUUID } from 'node:crypto';

/**
 * Branded string identifiers. The brand exists only at the type level; at runtime these are plain
 * strings. Branding prevents accidentally passing, say, a {@link ProviderId} where a {@link TaskId}
 * is expected.
 */
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type TaskId = Brand<string, 'TaskId'>;
export type EventId = Brand<string, 'EventId'>;
export type ProviderId = Brand<string, 'ProviderId'>;
export type ApprovalId = Brand<string, 'ApprovalId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;

const TASK_PREFIX = 'task';
const EVENT_PREFIX = 'evt';
const APPROVAL_PREFIX = 'apr';

const uuid = (): string => randomUUID();

export const newTaskId = (): TaskId => `${TASK_PREFIX}_${uuid()}` as TaskId;
export const newEventId = (): EventId => `${EVENT_PREFIX}_${uuid()}` as EventId;
export const newApprovalId = (): ApprovalId => `${APPROVAL_PREFIX}_${uuid()}` as ApprovalId;
export const newArtifactId = (): ArtifactId => `art_${uuid()}` as ArtifactId;

/** Cast a raw string (e.g. from the DB or an MCP argument) to a branded id. */
export const asTaskId = (value: string): TaskId => value as TaskId;
export const asEventId = (value: string): EventId => value as EventId;
export const asProviderId = (value: string): ProviderId => value as ProviderId;
export const asApprovalId = (value: string): ApprovalId => value as ApprovalId;
export const asSessionId = (value: string): SessionId => value as SessionId;
export const asArtifactId = (value: string): ArtifactId => value as ArtifactId;

/**
 * Provider ids are user-facing config keys (e.g. `codex`). They must be short, lowercase, and safe to
 * use as a directory / table-key segment.
 */
const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;

export const isValidProviderId = (value: string): boolean => PROVIDER_ID_RE.test(value);

export const parseProviderId = (value: string): ProviderId => {
  if (!isValidProviderId(value)) {
    throw new Error(
      `Invalid provider id "${value}": must match ${PROVIDER_ID_RE.source} (lowercase, digits, hyphen).`,
    );
  }
  return value as ProviderId;
};
