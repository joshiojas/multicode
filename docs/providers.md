# Writing a Multicode Provider

A **provider** teaches Multicode how to talk to a particular coding agent. Providers are the *only*
place provider-specific protocol lives; the core, persistence, security, and server layers stay
provider-neutral and negotiate against **declared capabilities**, never against a provider's name.

This guide shows how to implement, register, and validate a provider.

## The contract

Implement `ProviderAdapter` from `@multicode/provider-sdk`:

```ts
import type { ProviderAdapter, ProviderFactory } from '@multicode/provider-sdk';

class MyProvider implements ProviderAdapter {
  readonly descriptor = {
    id: 'my-agent',
    displayName: 'My Agent',
    version: '1.0.0',
    protocolVersion: 'my-proto-1',
    sdkVersion: '1.0.0', // the Multicode provider-SDK contract you built against
  };

  async capabilities() {
    return {
      streaming: true, resume: true, steering: false, approvals: true,
      cancellation: true, writeMode: true, readOnlyMode: true,
      sandboxLevels: ['read_only', 'workspace_write'], networkControl: true,
      // conservative defaults fill the rest
    };
  }

  async authStatus() {
    // Status ONLY — never return a token.
    return { authenticated: true, method: 'oauth', account: 'me@example.com' };
  }

  async startTask(input, ctx) {
    ctx.emit({ type: 'message', role: 'assistant', text: `working on: ${input.prompt}` });
    // …drive your agent, emitting events and awaiting approvals via ctx…
    return { status: 'completed', summary: '…', sessionId: 'abc', };
  }

  // Implement continueTask iff capabilities.resume, steerTask iff capabilities.steering.
}

export const createProvider: ProviderFactory = (init) => new MyProvider(/* init.config, init.logger */);
export default createProvider;
```

### The run context

`ctx` (a `ProviderRunContext`) gives you a **confined** workspace (`ctx.workspace.cwd` is the worktree
for write tasks), the resolved `policy`, an `AbortSignal` you must observe for cancellation, `emit(...)`
for streaming events, and `requestApproval(...)` which blocks until the operator decides.

### Capability honesty

Declare only what you truly support. The orchestrator negotiates against your capabilities:
`writeMode`/`readOnlyMode` gate the mode, `resume` gates `continue_task`, `steering` gates
`steer_task`, `approvals` is required when the policy must gate elevation, `sandboxLevels` and
`networkControl` gate policy enforcement. If you claim a capability, you must honor it — the conformance
suite checks this.

## Registering a provider

**Built-in** (bundled, like Codex): the composition root registers it.

```ts
registry.registerBuiltin('my-agent', createProvider);
```

**Third-party** (a separate npm package): configure it explicitly. It is dynamically imported,
validated against the SDK contract version, and **isolated** — if it fails to load, other providers are
unaffected and calls to it raise a clear error.

```jsonc
// config.json
{
  "providers": {
    "my-agent": {
      "enabled": true,
      "package": "@acme/multicode-provider-my-agent",
      "version": "^1.0.0",
      "config": { /* adapter-specific, validated by your adapter */ }
    }
  }
}
```

Your package must export the factory as `createProvider` or as its default export.

## Conformance: the shared bar

Every provider — built-in or third-party — must pass the shared conformance suite. It constructs your
adapter and, gated on your declared capabilities, checks that streaming emits events, resume returns a
session and `continueTask` works, approvals are actually requested, cancellation stops promptly, write
mode produces a file change, and `authStatus` never leaks a secret.

```ts
import { runConformance } from '@multicode/provider-sdk/conformance';
import { createProvider } from '../src/index.js';
import { it } from 'vitest';

it('passes provider conformance', async () => {
  await runConformance(createProvider); // throws on any failure
});
```

The reference `FakeProvider` (`@multicode/provider-sdk/testing`) is a fully-capable adapter you can copy
from, and is what the suite validates itself against.

## Case study: Codex

The Codex adapter (`@multicode/provider-codex`) integrates through the official Codex **App Server** — a
JSON-RPC 2.0 service over stdio (`codex app-server`) — **not** terminal scraping or `codex exec`. It:

- spawns the App Server and speaks newline-delimited JSON-RPC (`JsonRpcEndpoint`);
- maps Codex `codex/event` notifications to neutral events (`mapCodexMsg`);
- routes `execCommandApproval` / `applyPatchApproval` server→client requests through
  `ctx.requestApproval`;
- maps cancellation to `interruptConversation`;
- reports auth status by checking that `~/.codex/auth.json` exists, **without reading it**.

The exact method/event names are centralized in `protocol.ts` for alignment with a given Codex release,
and the whole adapter is validated by conformance against an in-process mock App Server, so it is
exercised without a real Codex binary.
