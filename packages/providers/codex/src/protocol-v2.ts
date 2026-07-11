import { z } from 'zod';

/**
 * The Codex App Server **v2 ("thread / turn / item") protocol** binding — current Codex (≳ 0.106,
 * incl. `main`). Verified against `openai/codex` `codex-rs/app-server-protocol` (schema + Rust). All
 * request method names are explicit slash-paths; all params/result fields are camelCase.
 */
export const METHODS_V2 = {
  initialize: 'initialize',
  /** Client→server notification sent after initialize (no params). */
  initialized: 'initialized',
  /** Start a thread (session). Auto-subscribes this connection to the thread's notifications. */
  threadStart: 'thread/start',
  /** Start a turn on a thread. Returns `{ turn: { id } }`. */
  turnStart: 'turn/start',
  /** Inject a message into the active turn (needs the expected turn id). */
  turnSteer: 'turn/steer',
  /** Interrupt an active turn. */
  turnInterrupt: 'turn/interrupt',
  /** Read the signed-in account (no token). Preferred over the deprecated getAuthStatus. */
  accountRead: 'account/read',
  /** Stop receiving a thread's notifications. */
  threadUnsubscribe: 'thread/unsubscribe',
} as const;

/** Server→client approval requests handled by this adapter (permissions elevation is declined). */
export const SERVER_REQUESTS_V2 = {
  execApproval: 'item/commandExecution/requestApproval',
  fileChangeApproval: 'item/fileChange/requestApproval',
} as const;

/** v2 approval decision values (a subset of the enum): accept / decline map to our approved / denied. */
export const V2_DECISIONS = {
  approved: 'accept',
  denied: 'decline',
} as const;

export const ThreadStartResult = z
  .object({ thread: z.object({ id: z.string() }).passthrough() })
  .passthrough();

export const TurnStartResult = z
  .object({ turn: z.object({ id: z.string() }).passthrough() })
  .passthrough();

/** `account/read` result: `{ account: Account | null, requiresOpenaiAuth }`. */
export const AccountReadResult = z
  .object({
    account: z
      .object({ type: z.string(), email: z.string().nullish(), planType: z.string().nullish() })
      .passthrough()
      .nullable()
      .optional(),
    requiresOpenaiAuth: z.boolean().optional(),
  })
  .passthrough();
