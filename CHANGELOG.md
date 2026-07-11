# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial monorepo scaffolding: `@multicode/core`, `@multicode/persistence`, `@multicode/security`,
  `@multicode/provider-sdk`, `@multicode/server`, `@multicode/provider-codex`, and `@multicode/cli`.
- Provider-neutral task domain model and transactional state machine.
- Durable SQLite persistence with forward-only migrations and boot-time recovery.
- Workspace-root validation, path-traversal protection, and Git worktree isolation.
- Stable provider adapter SDK with capability negotiation and a shared conformance suite.
- MCP tool surface for starting, monitoring, steering, continuing, cancelling, approving, and
  reviewing coding tasks over stdio.
- Codex provider adapter supporting **both** official App Server protocol generations, selected by
  `config.protocol` (default `v2`), each verified against the `openai/codex` source and passing the
  shared conformance suite:
  - **v2 "thread / turn / item"** (current Codex ≳ 0.106): `thread/start` → `turn/start`, item-lifecycle
    streaming, `thread/tokenUsage/updated`, `turn/steer` steering, and
    `item/commandExecution|fileChange/requestApproval` approvals.
  - **v1 "conversation"** (legacy Codex ≲ 0.105), additionally corroborated against real rollout data:
    mandatory `addConversationListener` subscription, `codex/event/<type>` notifications, base64
    command-output decoding, and `patch_apply_end` file-change mapping.
  - See the [Codex provider README](./packages/providers/codex/README.md#protocol-compatibility).
- CLI published on npm as **`multicode-mcp`** (the unscoped name `multicode` was already taken); it
  installs the `multicode` command. Run via `npx -y multicode-mcp serve`. Commands: `init`, `doctor`,
  `provider`, `task`, `approve`, `config`, and `serve`.
- Setup guide ([`docs/setup.md`](./docs/setup.md)) with verified install instructions for Claude Code,
  Claude Desktop, Cursor, Windsurf, VS Code (Copilot), Zed, Cline, Continue, and Gemini CLI, plus
  README architecture and task-flow diagrams.

[Unreleased]: https://github.com/joshiojas/multicode/commits/main
