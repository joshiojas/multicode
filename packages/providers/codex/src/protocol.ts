import { z } from 'zod';

/**
 * The Codex App Server protocol binding, centralized here.
 *
 * Multicode talks to Codex through the official **App Server** — a JSON-RPC-shaped service Codex
 * exposes over stdio (`codex app-server`), newline-delimited (JSONL) — not by scraping a terminal or
 * shelling out to `codex exec`.
 *
 * ## Protocol version
 *
 * This adapter implements the **v1 ("conversation") protocol**, verified against the `openai/codex`
 * source (`codex-rs/app-server-protocol` / `codex-rs/app-server`, tags `rust-v0.50.0`…`rust-v0.105.0`).
 * OpenAI **removed** these client methods around Codex **v0.106** in favor of a v2 "thread / turn /
 * item" protocol (`thread/start`, `turn/start`, `item/*` notifications). So:
 *
 * - **Codex ≲ 0.105** → this v1 binding is correct.
 * - **Codex ≳ 0.106 (incl. current `main`)** → needs the v2 binding (tracked; see the package README).
 *
 * Wire conventions (v1), which are deliberately mixed and easy to get wrong:
 * - request/response **method names** are camelCase (`newConversation`, `addConversationListener`);
 * - request/response **param fields** are camelCase (`conversationId`, `approvalPolicy`, `sandboxPolicy`);
 * - streamed events arrive as notifications named **`codex/event/<snake_type>`** (NOT plain
 *   `codex/event`), with params `{ id, msg: { type, … }, conversationId }` — `msg.type` and all event
 *   payload fields are **snake_case**, while the injected `conversationId` is camelCase;
 * - **you MUST call `addConversationListener` after `newConversation`** or no events are delivered.
 */
export const METHODS = {
  /** Handshake; negotiates protocol/capabilities. */
  initialize: 'initialize',
  /** Create a new conversation (session). Returns `{ conversationId, rolloutPath, … }`. */
  newConversation: 'newConversation',
  /** REQUIRED after newConversation to receive streamed events. Returns `{ subscriptionId }`. */
  addConversationListener: 'addConversationListener',
  /** Stop receiving events for a subscription. */
  removeConversationListener: 'removeConversationListener',
  /** Send a user message on a conversation (reuses the conversation's turn settings). */
  sendUserMessage: 'sendUserMessage',
  /** Interrupt the active turn of a conversation (cooperative cancel). */
  interruptConversation: 'interruptConversation',
  /** Query login status (never returns a token unless explicitly asked, which we never do). */
  getAuthStatus: 'getAuthStatus',
} as const;

/** Server→client requests (Codex asks the client to decide something). */
export const SERVER_REQUESTS = {
  execCommandApproval: 'execCommandApproval',
  applyPatchApproval: 'applyPatchApproval',
} as const;

/**
 * The prefix of streamed-event notification methods: `codex/event/<msg_type>` (e.g.
 * `codex/event/agent_message`). Plain `codex/event` (no suffix) is what the separate `codex mcp`
 * subcommand emits — not the app-server — so we match on the prefix.
 */
export const EVENT_NOTIFICATION_PREFIX = 'codex/event/';

/** The four allowed values of Codex's `ReviewDecision` (snake_case). */
export const REVIEW_DECISIONS = ['approved', 'approved_for_session', 'denied', 'abort'] as const;

// ── Result schemas ────────────────────────────────────────────────────────────

export const NewConversationResult = z.object({ conversationId: z.string() }).passthrough();

export const AddListenerResult = z.object({ subscriptionId: z.string() }).passthrough();

export const AuthStatusResult = z
  .object({
    authenticated: z.boolean().optional(),
    // Codex reports `authMethod`; accept `method` too.
    method: z.string().optional(),
    authMethod: z.string().optional(),
    account: z.string().optional(),
    email: z.string().optional(),
    expiresAt: z.string().optional(),
  })
  .passthrough();

// ── Streamed event schema ───────────────────────────────────────────────────

/**
 * A `codex/event/<type>` notification's params: `{ id, msg: { type, … }, conversationId }`. We validate
 * leniently (passthrough) so unknown event kinds from newer Codex versions are ignored, not fatal.
 */
export const CodexEventNotification = z
  .object({
    id: z.string().optional(),
    conversationId: z.string().optional(),
    msg: z.record(z.unknown()),
  })
  .passthrough();

export type CodexEventNotification = z.infer<typeof CodexEventNotification>;

/** Known `msg.type` values the adapter maps. Unknown types are ignored. */
export const CODEX_EVENT_TYPES = {
  agentMessage: 'agent_message',
  agentMessageDelta: 'agent_message_delta',
  agentReasoning: 'agent_reasoning',
  execBegin: 'exec_command_begin',
  execDelta: 'exec_command_output_delta',
  execEnd: 'exec_command_end',
  turnDiff: 'turn_diff',
  patchApplyBegin: 'patch_apply_begin',
  patchApplyEnd: 'patch_apply_end',
  tokenCount: 'token_count',
  taskStarted: 'task_started',
  taskComplete: 'task_complete',
  error: 'error',
  streamError: 'stream_error',
} as const;
