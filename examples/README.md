# Examples

- [`claude-code.md`](./claude-code.md) — register and use Multicode from Claude Code.
- [`generic-mcp-client.mjs`](./generic-mcp-client.mjs) — a standalone Node script that spawns
  `multicode serve` over stdio and drives the tools with the MCP TypeScript SDK.

Both assume you have run the one-time setup:

```bash
npx -y multicode-mcp init
npx -y multicode-mcp provider login codex   # reuses Codex's own login; no token touches Multicode
npx -y multicode-mcp doctor                 # verify everything is wired up
```
