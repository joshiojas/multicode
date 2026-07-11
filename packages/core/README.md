# @multicode/core

The provider-neutral heart of [Multicode](https://github.com/joshiojas/multicode). Nothing here imports
a provider, a transport, or a persistence engine.

It defines the domain: branded identifiers, an injectable `Clock`, a structured `Logger` interface, the
error taxonomy, the task **state machine** (`TASK_STATUSES`, `assertTransition`, `reconcileOnRecovery`),
execution policy (mode/sandbox/network/approvals/limits), provider **capabilities** and negotiation,
the append-only **event model**, approvals, artifacts, verification/result types, and the Zod
configuration schema.

```ts
import { assertTransition, ProviderCapabilities, MulticodeConfig } from '@multicode/core';
```

See the [architecture docs](https://github.com/joshiojas/multicode/blob/main/docs/architecture.md).

Licensed under Apache-2.0.
