# 0001 — Integrate Codex through the official App Server

- Status: Accepted
- Date: 2026-07

## Context

Codex can be driven several ways: scraping its interactive terminal UI, invoking `codex exec`
one-shot, or connecting to its official **App Server** — a structured JSON-RPC service (`codex
app-server`) designed for programmatic clients. Multicode needs streamed events, approval round-trips,
resumable sessions, structured results, and cancellation. It also needs a binding that stays stable as
Codex evolves.

## Decision

Integrate Codex **only** through the official App Server, speaking JSON-RPC 2.0 over stdio. Do not
scrape the terminal and do not shell out to `codex exec`.

The adapter (`@multicode/provider-codex`) is structured as: a transport-agnostic `JsonRpcEndpoint`, a
newline-delimited stdio `ChildProcessTransport`, an event translation layer (`mapCodexMsg`), and the
`CodexProvider`. All Codex method/event names live in one `protocol.ts` module so a Codex release rename
is a one-file change.

## Consequences

- **Positive:** structured, versioned protocol; first-class approvals, streaming, cancellation, and
  resume; no brittle screen-scraping; the transport is injectable, so the adapter is fully tested
  against an in-process mock App Server and the shared conformance suite — no real Codex binary needed
  in CI.
- **Negative:** requires a Codex build that exposes the App Server; the exact method/event names must be
  aligned to the installed Codex version (mitigated by centralizing them).
- **Auth:** login reuses `codex login`; Multicode reads only login *status* and never the token.

## Protocol version (both implemented, verified against `openai/codex` source)

There are **two protocol generations**, and the adapter implements **both**, selected by
`config.protocol` (default `v2`):

- **v2** "thread / turn / item" (`thread/start`, `turn/start`, `item/*` notifications, auto-subscribed,
  `turn/steer` for steering) — **current Codex** (≳ 0.106, incl. `main`). Default.
- **v1** "conversation" (`newConversation`, `addConversationListener`, `sendUserMessage`,
  `codex/event/<type>`) — legacy Codex (≲ 0.105), removed around v0.106.

Non-obvious facts the bindings encode (found during verification; two were latent v1 bugs, now fixed):
v1 events are `codex/event/<snake_type>` (not `codex/event`) and `addConversationListener` is
**mandatory** or no events arrive; v1 `exec_command_output_delta.chunk` is base64 and the file-change
map is on `patch_apply_end`. v2 auto-subscribes on `thread/start`, streams via the item lifecycle
(final text = completed `agentMessage.text`), reports usage via `thread/tokenUsage/updated`, and uses
`accept`/`decline` approval decisions. Across both, methods/params are camelCase and the transport is
newline-delimited JSON with no `jsonrpc` field. v1 event strings were corroborated against real Codex
rollout data. Both drivers pass the shared conformance suite against faithful mock App Servers; a live
end-to-end run against a real `codex app-server` is still recommended before GA.
