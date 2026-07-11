# @multicode/server

The provider-neutral MCP server and task orchestrator for
[Multicode](https://github.com/multicode/multicode).

- The **Orchestrator**: durable task lifecycle, event streaming, approval routing, cancellation and
  timeouts, Git-based verification, worktree lifecycle, and boot-time recovery.
- The **MCP tool surface** (Zod-validated) and both transports (`serveStdio`, secure `serveHttp`).
- `bootstrap(...)` wires a `Store`, `WorkspaceGuard`, `WorktreeManager`, and `Orchestrator` from config.

It never imports a concrete provider — the composition root registers providers on a
`ProviderRegistry` and passes it in.

```ts
import { bootstrap, createMcpServer, serveStdio, createLogger } from '@multicode/server';
```

Licensed under Apache-2.0.
