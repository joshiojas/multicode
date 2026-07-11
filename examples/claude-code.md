# Using Multicode from Claude Code

Multicode is an MCP server, so Claude Code can call its tools to delegate work to Codex (or any
configured provider).

## 1. Register the server

```bash
claude mcp add multicode -- npx -y multicode serve
```

This adds an entry equivalent to:

```json
{
  "mcpServers": {
    "multicode": { "command": "npx", "args": ["-y", "multicode", "serve"] }
  }
}
```

## 2. Make sure a workspace root is approved

Multicode only runs tasks rooted in approved directories. `multicode init` approves the current
directory; add more by editing `~/.multicode/config.json`:

```jsonc
{
  "workspaceRoots": ["/Users/you/code/my-project"],
  "providers": { "codex": { "enabled": true, "args": ["app-server"] } }
}
```

Validate it: `npx multicode config validate`.

## 3. Delegate a task

Ask Claude Code to use the Multicode tools. A typical read-only review:

> Use `multicode_start_task` with providerId `codex`, mode `read_only`, workspaceRoot
> `/Users/you/code/my-project`, prompt "Find and explain the top 3 performance risks." Then poll
> `multicode_get_task` and summarize `multicode_get_events`.

A write task that produces a verified diff:

> Start a `write` task (sandbox `workspace_write`) with Codex to "add input validation to the signup
> handler and a test." When it finishes, show me `multicode_get_diff`.

## 4. Approvals

If a task needs an elevated action and your approval policy is `on_request`, the task parks in
`awaiting_approval` and surfaces an `approval.requested` event. Approve it with the
`multicode_respond_approval` tool (or `npx multicode approve <approvalId>`), then the task continues.

## 5. Interactive sessions

Start with `interactive: true` to keep the session alive. Use `multicode_continue_task` to send
follow-ups and `multicode_steer_task` to nudge a running turn (if the provider supports steering).
Finish an interactive session with `multicode_cancel_task`.

## Tool reference

`multicode_list_providers`, `multicode_start_task`, `multicode_get_task`, `multicode_list_tasks`,
`multicode_get_events`, `multicode_continue_task`, `multicode_steer_task`,
`multicode_respond_approval`, `multicode_cancel_task`, `multicode_get_diff`,
`multicode_get_artifacts`.
