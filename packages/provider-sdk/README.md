# @multicode/provider-sdk

The stable contract for building [Multicode](https://github.com/joshiojas/multicode) providers, plus
capability negotiation, an isolation-aware registry/loader, and the shared conformance suite.

```ts
import type { ProviderAdapter, ProviderFactory } from '@multicode/provider-sdk';
import { runConformance } from '@multicode/provider-sdk/conformance';
import { FakeProvider } from '@multicode/provider-sdk/testing';
```

- Implement `ProviderAdapter` and declare honest `ProviderCapabilities`; the orchestrator negotiates
  against capabilities, never provider identity.
- Third-party providers are explicitly configured, version-validated against the SDK contract, and
  **isolated** on failure.
- Every provider must pass `runConformance(factory)` — the same suite the reference `FakeProvider`
  passes.

See the [provider guide](https://github.com/joshiojas/multicode/blob/main/docs/providers.md).

Licensed under Apache-2.0.
