# Contributing to Multicode

Thanks for your interest in improving Multicode. This document explains how to get set up, the
standards we hold code to, and how to propose changes.

## Ground rules

- Be respectful. See [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
- The **core stays provider-neutral.** `@multicode/core`, `@multicode/persistence`, and
  `@multicode/server` must never import a provider package or hardcode a provider name. Provider
  behaviour is discovered through capability negotiation.
- **Security is not optional.** Changes that touch path handling, worktrees, sandboxing, or approvals
  need tests, and usually a property-based test.

## Getting set up

```bash
git clone https://github.com/joshiojas/multicode
cd multicode
corepack enable
pnpm install
pnpm build
pnpm test
```

Requirements: Node >= 20.10, pnpm >= 9, git.

## Workflow

1. Create a branch off `main`.
2. Make your change with tests. Keep commits focused.
3. Run the full gate locally:
   ```bash
   pnpm build && pnpm lint && pnpm typecheck && pnpm test
   ```
4. Update `CHANGELOG.md` under `## [Unreleased]`.
5. Open a PR. CI must be green.

## Commit and PR conventions

- Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`) are encouraged.
- Reference issues where relevant.
- A PR that changes public API must update the affected package's docs and, if the change is
  behavioural, add an ADR under [`docs/adr`](./docs/adr).

## Adding a provider

Provider adapters implement the [`@multicode/provider-sdk`](./packages/provider-sdk) contract and must
pass the shared conformance suite:

```bash
pnpm --filter @multicode/provider-sdk test
```

See [`docs/providers.md`](./docs/providers.md) for the full guide.

## Testing tiers

| Tier | Where | What |
|---|---|---|
| Unit | `*.test.ts` beside source | Pure logic, state machine, validators. |
| Integration | `packages/*/test/integration` | SQLite persistence, worktree lifecycle. |
| Contract | `packages/provider-sdk` conformance | Every adapter runs the same suite. |
| Property | `packages/security` | Path traversal / confinement invariants via `fast-check`. |

## Releasing (maintainers)

Releases are semver. Tag `vX.Y.Z`, update the changelog, and publish per
[`docs/releasing.md`](./docs/releasing.md).
