# Multicode Architecture

Multicode is a **secure, local-first modular monolith**. It runs in one process by default, persists
everything durably on the local disk, and keeps its seams — persistence, transports, providers, and
execution runtimes — behind interfaces so that distributed variants (PostgreSQL, remote execution,
hosted deployments) can be added later without redesigning the core.

This document explains the layering, the task lifecycle, the data model, and the key runtime flows.

## Layering

```
                         ┌─────────────────────────────────────────────┐
   MCP client            │  Claude Code · Cursor · IDE agent · custom   │
   (any)                 └───────────────────────┬─────────────────────┘
                                                 │  MCP (stdio / Streamable HTTP)
                         ┌───────────────────────▼─────────────────────┐
                         │               multicode-mcp                  │  composition root
                         │  init · doctor · provider · task · serve     │  (binds providers)
                         └───────────────────────┬─────────────────────┘
                         ┌───────────────────────▼─────────────────────┐
                         │            @multicode/server                 │
                         │  MCP tools · Orchestrator · recovery         │
                         │  approvals · verification · transports       │
                         └───┬───────────────┬───────────────┬─────────┘
             ┌───────────────▼──┐   ┌────────▼────────┐   ┌──▼────────────────┐
             │ @multicode/      │   │ @multicode/     │   │ @multicode/       │
             │ persistence      │   │ security        │   │ provider-sdk      │
             │ Store (SQLite)   │   │ worktrees, git, │   │ adapter contract, │
             │ migrations       │   │ path guards,    │   │ registry,         │
             │ transitions      │   │ exec, policy    │   │ conformance       │
             └───────┬──────────┘   └────────┬────────┘   └──┬────────────────┘
                     └───────────────┬───────┴───────────────┘
                             ┌───────▼────────┐        ┌───────────────────────┐
                             │ @multicode/core│        │ @multicode/provider-   │
                             │ domain, types, │        │ codex (App Server)     │
                             │ state machine, │◄───────┤ …future providers      │
                             │ events, config │  impl  └───────────────────────┘
                             └────────────────┘
```

**The dependency rule:** arrows point toward `@multicode/core`. The core, persistence, security, and
server layers **never import a provider**. Concrete providers are bound only at the composition root
(the `multicode-mcp` CLI), which registers them on a `ProviderRegistry`. This is what keeps the system
model-agnostic: adding a provider touches only its own package plus one registration line.

## Packages

| Package | Depends on | Responsibility |
|---|---|---|
| `core` | (zod only) | Domain model: ids, clock, logging interface, error taxonomy, task **state machine**, execution policy, provider **capabilities**, events, approvals, artifacts, verification/result, and the config schema. Pure — no I/O. |
| `persistence` | core | The `Store` interface + a SQLite implementation with forward-only migrations, **transactional** transitions, event sequencing, and recovery queries. |
| `security` | core | Workspace-root confinement, path-traversal & symlink-escape guards, Git worktree lifecycle, ground-truth diffing, bounded output, safe process execution, and policy resolution (no silent privilege escalation). |
| `provider-sdk` | core | The stable `ProviderAdapter` contract, capability negotiation, an isolation-aware registry/loader, and the shared **conformance suite** + reference `FakeProvider`. |
| `server` | core, persistence, security, provider-sdk | The `Orchestrator` (lifecycle engine), the MCP tool surface, event streaming, approval routing, boot recovery, verification, and both transports. |
| `provider-codex` | core, provider-sdk | The Codex adapter over the official **App Server** (JSON-RPC/stdio). |
| `cli` | all of the above | The `multicode` binary and composition root. |

## The task lifecycle

A task is the unit of delegated work. Its status is governed by an explicit state machine
(`core/domain/status.ts`); illegal transitions are rejected at both the orchestrator and the store.

```
 pending ──▶ provisioning ──▶ running ──▶ succeeded            (one-shot success, terminal)
    │             │            │  ▲ │
    │             │            │  │ ├─▶ awaiting_approval ──┐   (blocked on an approval)
    │             │            │  └──── awaiting_input ◀────┘   (interactive: resumable idle)
    │             │            │
    └──────┬──────┴────────────┴──▶ cancelling ──▶ cancelled   (terminal)
           └────────────────────────────────────▶ failed / timed_out  (terminal)
```

- **One-shot vs interactive.** By default a task is one-shot: a completed turn is terminal
  (`succeeded`) and its worktree is cleaned up — the crisp "delegate → verified diff → done" flow.
  With `interactive: true`, a completed turn parks in `awaiting_input` so it can be continued or
  steered; its worktree is retained until the session is finalized.
- **Every transition is transactional.** The store applies the status change, the field patch, and any
  appended events in a single SQLite transaction guarded by an optimistic-concurrency `revision`. Two
  writers can never interleave a transition silently.

## Durability & recovery

Everything a task produces — its record, its event log, approvals, and artifacts — lives in SQLite
(WAL mode, `synchronous=NORMAL`, foreign keys on). Because state is durable and transitions are
atomic, tasks survive **MCP client disconnects** (the client just reconnects and pages events from a
cursor), **provider crashes** (the turn fails; the record persists), and **Multicode restarts**.

On boot, `Orchestrator.recover()` finds every task left in an *active* state (`provisioning`,
`running`, `awaiting_approval`, `cancelling`) by the previous instance and reconciles it
deterministically (`core`'s `reconcileOnRecovery`):

- `cancelling` → `cancelled`.
- `provisioning` → `failed` (no session existed yet).
- `running` / `awaiting_approval` → `awaiting_input` if the provider is resumable and a session id was
  captured, else `failed`.

Each reconciliation is itself a legal, audited transition with an explanatory event.

## Event streaming

Every meaningful thing that happens is an append-only `TaskEvent` with a per-task, monotonically
increasing `seq`. Clients call `multicode_get_events(taskId, afterSeq)` to page forward and resume
streaming deterministically after a disconnect. Provider output is translated from the neutral
`ProviderEvent` space into durable events by the orchestrator; lifecycle events (status changes,
approvals, results) are owned by the orchestrator.

## Approvals

When a provider requests an elevated action, the adapter calls `ctx.requestApproval(...)`. The
orchestrator applies the configured policy:

- `never` → auto-deny (recorded for audit);
- `auto` → auto-approve (recorded);
- `on_request` / `on_failure` → persist a **pending** approval, move the task to `awaiting_approval`,
  and block the turn until the decision arrives.

A decision can arrive through the `multicode_respond_approval` MCP tool (in-process) **or** through the
`multicode approve` CLI writing to the store (possibly a different process); the orchestrator races an
in-memory promise against a store poll so either surface works.

## Verification

Multicode never trusts an agent's account of what it did. At the end of a write turn it computes the
**ground-truth diff** from Git (`git add -A` in the throwaway worktree, then `git diff --cached
<baseRef>` with rename detection off), records real command exit codes observed from the event stream,
stores the unified patch as a SHA-256-stamped artifact, and sets `changeConfirmed` only when there is
objective evidence (a non-empty diff or an artifact). `multicode_get_diff` returns this verified
summary.

## Security boundaries

See [`security.md`](./security.md) for the full threat model. In brief: every path is confined to an
approved workspace root (lexical **and** symlink-resolved), write tasks run in isolated worktrees,
sandbox/network/approval policy is resolved without silent escalation and asserted enforceable by the
provider, output is byte-bounded, and provider tokens are never read or persisted.

## Extensibility seams

| Seam | Interface | Swap-in later |
|---|---|---|
| Persistence | `Store` (async) | PostgreSQL / hosted DB |
| Providers | `ProviderAdapter` + `ProviderRegistry` | any coding agent |
| Transport | `serveStdio` / `serveHttp` | additional transports |
| Execution | `runCommand` / `WorktreeManager` | remote/sandboxed runners |
| Clock | `Clock` | deterministic time in tests |

Each is already an interface with at least one implementation and a test double, so the distributed
future is additive, not a rewrite.
