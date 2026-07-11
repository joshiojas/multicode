# 0002 — SQLite with transactional, versioned state transitions

- Status: Accepted
- Date: 2026-07

## Context

Long-running tasks must survive client disconnects, provider crashes, and Multicode restarts. That
requires durable local persistence with a clear, correct recovery story. We also need atomic state
transitions — a status change, its field updates, and its emitted events must land together or not at
all — and protection against two writers clobbering each other.

## Decision

Use **SQLite** (via `better-sqlite3`) as the default store, behind an async `Store` interface.

- **Transactional transitions:** `applyTransition` runs inside a synchronous better-sqlite3 transaction
  that verifies an optimistic-concurrency `revision`, validates the state-machine edge, applies the
  patch, bumps the revision, and appends events — atomically.
- **No leaky transaction handle:** the store exposes *atomic domain operations*, not a generic
  `transaction(fn)` (which cannot be both async-friendly and atomic).
- **Forward-only migrations** recorded in `schema_migrations`, each applied in its own transaction.
- **WAL** journaling with `synchronous=NORMAL` and foreign keys on.

## Consequences

- **Positive:** true atomicity and durability with zero external services; deterministic recovery;
  concurrent readers (CLI inspection) alongside the running server.
- **Negative:** a native dependency (mitigated by prebuilt binaries); single-writer model.
- **Future:** the async `Store` interface lets a PostgreSQL/hosted backend be added later without
  changing callers; only the interface's atomicity contract must be honored.
