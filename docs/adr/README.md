# Architecture Decision Records

These ADRs capture the significant, hard-to-reverse decisions behind Multicode and the reasoning that
led to them. New architectural changes should add a new record rather than editing an existing one.

Format: [MADR](https://adr.github.io/madr/)-style — Context, Decision, Consequences.

| # | Title | Status |
|---|---|---|
| [0001](./0001-codex-via-app-server.md) | Integrate Codex through the official App Server | Accepted |
| [0002](./0002-sqlite-transactional-persistence.md) | SQLite with transactional, versioned state transitions | Accepted |
| [0003](./0003-worktree-isolation-and-verification.md) | Git worktree isolation and diff-based verification | Accepted |
| [0004](./0004-capability-negotiation.md) | Capability negotiation over hardcoded provider checks | Accepted |
| [0005](./0005-local-first-modular-monolith.md) | Local-first modular monolith behind interface seams | Accepted |
