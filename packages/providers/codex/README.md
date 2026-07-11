# @multicode/provider-codex

The [Codex](https://developers.openai.com/codex/) provider for
[Multicode](https://github.com/joshiojas/multicode), integrated through the official Codex **App
Server** (JSON-RPC 2.0 over stdio) — **not** terminal scraping or `codex exec`.

- Spawns `codex app-server` and speaks newline-delimited JSON-RPC.
- Streams Codex events into Multicode's neutral event model.
- Routes command- and patch-approval requests through the run context's approval channel.
- Maps cancellation (and, on v2, steering) to the App Server's turn controls.
- Reports login status without ever reading the token (`~/.codex/auth.json` existence only).

Supports **both** Codex App Server protocol generations — v2 (default) and v1 — selected by
`config.protocol`. See [Protocol compatibility](#protocol-compatibility) below.

Codex is registered as a **built-in** provider by the Multicode CLI; you can also configure it as a
package provider. The App Server method/event names are centralized in `protocol.ts` for alignment with
a given Codex release, and the adapter is validated by the shared conformance suite against a mock App
Server.

## Protocol compatibility

This adapter implements **both** Codex App Server protocol generations, verified against the
`openai/codex` source (JSON schemas + Rust) and passing the shared conformance suite. Select with
`config.protocol`:

| Codex version | Protocol | `config.protocol` | Status |
|---|---|---|---|
| **≳ 0.106** (incl. current `main`, ~0.144) | v2 "thread / turn / item" (`thread/start`, `turn/start`, `item/*`) | `"v2"` (**default**) | ✅ Supported |
| **≲ 0.105** (`rust-v0.50.0`…`rust-v0.105.0`) | v1 "conversation" (`newConversation`, `sendUserMessage`, `codex/event/<type>`) | `"v1"` | ✅ Supported |

```jsonc
// config.json — pin to v1 for an older Codex (default is v2)
{ "providers": { "codex": { "enabled": true, "config": { "protocol": "v1" } } } }
```

Non-obvious protocol facts the bindings get right (verified; two were latent v1 bugs, now fixed):

- **v2** auto-subscribes on `thread/start`; the item lifecycle is `item/started` → deltas →
  `item/completed`; the final assistant text is the completed `agentMessage` item's `text`; token usage
  arrives via `thread/tokenUsage/updated`; steering is supported (`turn/steer`); approvals are
  `item/commandExecution/requestApproval` / `item/fileChange/requestApproval` with decision
  `accept`/`decline`.
- **v1** streamed events arrive as **`codex/event/<snake_type>`** (not plain `codex/event`);
  **`addConversationListener` is mandatory** after `newConversation` or zero events arrive;
  `exec_command_output_delta.chunk` is **base64**; the file-change map is on `patch_apply_end`.
- Across both: methods/params are camelCase; the transport is newline-delimited JSON with **no
  `jsonrpc` version field**.

The v1 event strings were additionally corroborated against real Codex rollout data. Check
`codex --version` to pick the protocol.

Licensed under Apache-2.0.
