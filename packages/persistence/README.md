# @multicode/persistence

Durable, transactional storage for [Multicode](https://github.com/joshiojas/multicode) behind a
backend-agnostic `Store` interface, with a SQLite implementation.

- Forward-only migrations recorded in `schema_migrations`.
- **Atomic** state transitions with optimistic-concurrency (`revision`) — status change, field patch,
  and appended events land together or not at all.
- Contiguous per-task event sequencing for resumable streaming.
- Recovery queries for boot-time reconciliation.

```ts
import { SqliteStore } from '@multicode/persistence';
const store = await SqliteStore.open({ path: '/path/to/multicode.db' });
```

The async interface leaves room for a PostgreSQL/hosted backend later without changing callers.

Licensed under Apache-2.0.
