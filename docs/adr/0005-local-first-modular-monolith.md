# 0005 — Local-first modular monolith behind interface seams

- Status: Accepted
- Date: 2026-07

## Context

The problem invites over-engineering: a distributed system with a job queue, remote workers, a hosted
database, and a control plane. But the primary use case is a developer delegating tasks from a local
MCP client to a local coding agent. Premature distribution adds operational burden and attack surface
without value.

## Decision

Ship a **secure, local-first modular monolith**: one process, durable local SQLite, in-process
orchestration, stdio transport by default. But keep the seams — persistence, transports, providers, and
execution runtimes — behind interfaces from day one.

## Consequences

- **Positive:** trivial install (`npx multicode-mcp`), no services to run, a small trusted computing base,
  and fast iteration. The interface seams (`Store`, `ProviderAdapter`/`ProviderRegistry`,
  `serveStdio`/`serveHttp`, `runCommand`/`WorktreeManager`, `Clock`) mean remote execution,
  PostgreSQL, hosted deployments, and new providers are **additive** later, not a redesign.
- **Negative:** a single process is a scaling ceiling and a single point of failure — acceptable for the
  local-first target, and explicitly revisitable behind the same interfaces.
- **Guardrail:** optional Streamable HTTP exists for controlled remote access, hardened (loopback
  default, mandatory token off-loopback, DNS-rebinding protection).
