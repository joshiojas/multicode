# Examples

- [`claude-code.md`](./claude-code.md) — register and use Multicode from Claude Code.
- [`generic-mcp-client.mjs`](./generic-mcp-client.mjs) — a standalone Node script that spawns
  `multicode serve` over stdio and drives the tools with the MCP TypeScript SDK.

Both assume you have run the one-time setup:

```bash
npx multicode init
npx multicode provider login codex   # reuses Codex's own login; no token touches Multicode
npx multicode doctor                 # verify everything is wired up
```
