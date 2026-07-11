# Releasing

Multicode follows [Semantic Versioning](https://semver.org). All publishable packages share a version
line and are released together.

## Checklist

1. Ensure `main` is green: `pnpm install && pnpm build && pnpm lint && pnpm typecheck && pnpm test`.
2. Move the `## [Unreleased]` section of [`CHANGELOG.md`](../CHANGELOG.md) under a new
   `## [X.Y.Z] - YYYY-MM-DD` heading; summarize user-facing changes.
3. Bump versions across the workspace packages to `X.Y.Z` (keep them in lockstep). Update the
   `sdkVersion`/`PROVIDER_SDK_CONTRACT_VERSION` only on a **breaking** provider-SDK change (its major
   version gates adapter compatibility — see [ADR 0004](./adr/0004-capability-negotiation.md)).
4. Commit: `chore(release): vX.Y.Z`. Tag: `git tag vX.Y.Z`.
5. Publish (public packages only; `multicode-monorepo` is private):
   ```bash
   pnpm -r --filter "./packages/**" publish --access public
   ```
6. Push: `git push && git push --tags`. Create a GitHub release from the tag with the changelog notes.

## Versioning rules of thumb

- **patch** — bug fixes, doc changes, internal refactors with no API change.
- **minor** — new tools, new provider capabilities, new config fields (backward compatible).
- **major** — removed/renamed MCP tools or config keys, breaking `Store`/`ProviderAdapter` changes, or a
  provider-SDK contract bump.

## Provider-SDK compatibility

Third-party providers declare the `sdkVersion` they were built against. The registry loads a provider
only if its major version matches this build's `PROVIDER_SDK_CONTRACT_VERSION`; incompatible providers
are isolated with a clear error rather than crashing the server.
