# multicode

The CLI and composition root for [Multicode](https://github.com/multicode/multicode) — a model-agnostic
MCP server for delegating software-engineering tasks to external coding agents.

```bash
npx multicode init                 # create the data dir + a starter config
npx multicode provider login codex # reuse Codex's own login (no token touches Multicode)
npx multicode doctor               # verify the setup
npx multicode serve                # run the MCP server over stdio (default)
```

Commands: `init`, `serve` (`--transport stdio|http`), `doctor`, `provider (list|status|login)`,
`task (list|get|events|diff)`, `approve`, `config (validate|path|show)`.

Register with Claude Code:

```bash
claude mcp add multicode -- npx -y multicode serve
```

This package is the only one that binds a concrete provider (registering Codex as a built-in), keeping
the rest of the system provider-neutral.

Licensed under Apache-2.0.
