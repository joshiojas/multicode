# 0004 — Capability negotiation over hardcoded provider checks

- Status: Accepted
- Date: 2026-07

## Context

A model-agnostic system that special-cases providers with `if (provider === 'codex')` branches rots
quickly and makes third-party providers second-class. Different agents support different features
(streaming, resume, steering, approvals, sandbox levels, network control).

## Decision

Providers **declare capabilities** (`ProviderCapabilities`), and the orchestrator negotiates against
those declarations — never against a provider's identity.

- A single choke point (`requireCapabilities` / `negotiate*`) asserts the capabilities a given operation
  needs, throwing a structured `CapabilityError` listing what is missing.
- Policy enforceability is likewise checked against capabilities (`assertPolicyEnforceable`): sandbox
  level, write mode, and network control must be *enforceable* by the chosen provider.
- Capabilities default conservatively, so an under-specified provider is treated as minimally capable.
- The shared conformance suite enforces capability *honesty*: claim a capability and you must honor it.

## Consequences

- **Positive:** zero provider-name branching in the core; new providers are first-class the moment they
  declare (and honor) capabilities; clear, actionable errors when a task needs something a provider
  lacks.
- **Negative:** providers must describe themselves accurately; a dishonest declaration is caught by
  conformance, not at runtime by the core.
