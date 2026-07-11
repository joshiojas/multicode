# Security Policy

Multicode runs untrusted coding-agent output against your source tree. We take its security posture
seriously and welcome responsible disclosure.

## Reporting a vulnerability

**Do not open a public issue for security problems.** Instead, use GitHub's private
["Report a vulnerability"](https://github.com/multicode/multicode/security/advisories/new) flow, or
email `security@multicode.dev` with:

- A description of the issue and its impact.
- Steps to reproduce (a minimal proof of concept helps).
- Affected versions/commit.

We aim to acknowledge within 3 business days and to ship a fix or mitigation for confirmed,
high-severity issues within 30 days. We will credit reporters who wish to be credited.

## Scope

In scope:

- Escapes from the workspace root or a task worktree (path traversal, symlink abuse).
- Bypasses of approval policy, sandbox, or network restrictions.
- Exposure or persistence of provider subscription tokens.
- Persistence corruption that violates the documented recovery guarantees.

Out of scope:

- Vulnerabilities in a provider CLI or its App Server (report those upstream).
- Misconfiguration that grants a task an intentionally broad workspace root.

## Hardening guarantees

The threat model, trust boundaries, and the specific invariants Multicode enforces (workspace-root
confinement, worktree isolation, no-token-persistence, bounded output) are documented in
[`docs/security.md`](./docs/security.md). Property-based tests in `@multicode/security` exercise the
path-confinement invariants on every CI run.
