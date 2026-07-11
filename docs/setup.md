<!-- markdownlint-disable MD033 -->

# Setup Guide

This guide takes you from zero to Multicode running inside your MCP client.

- [1. Prerequisites](#1-prerequisites)
- [2. Install](#2-install)
- [3. First-time setup](#3-first-time-setup)
- [4. Add Multicode to your MCP client](#4-add-multicode-to-your-mcp-client)
- [5. Remote / HTTP transport](#5-remote--http-transport)
- [6. Configuration reference](#6-configuration-reference)
- [7. Troubleshooting](#7-troubleshooting)
- [8. Uninstall](#8-uninstall)

> **How it works in one line:** your MCP client launches `multicode serve` (stdio by default), and
> Multicode exposes tools that delegate coding tasks to a provider (Codex first) — running writes in an
> isolated Git worktree and returning a **verified diff**.

## 1. Prerequisites

| Requirement | Why | Check |
|---|---|---|
| **Node.js ≥ 20.10** | runtime | `node --version` |
| **git** | worktree isolation + verified diffs | `git --version` |
| A provider CLI | the agent Multicode delegates to | e.g. `codex --version` |

For the **Codex** provider you need the Codex CLI installed and its **App Server** available
(`codex app-server`). Multicode talks to Codex through the App Server — never by scraping a terminal or
shelling out to `codex exec`.

> [!NOTE]
> The Codex adapter supports **both** App Server protocol generations, selected by `config.protocol`:
> **v2** (default; current Codex ≳ 0.106) and **v1** (legacy Codex ≲ 0.105). Check `codex --version`;
> if you're on old Codex, set `providers.codex.config.protocol` to `"v1"`. See the
> [Codex provider README](../packages/providers/codex/README.md#protocol-compatibility).

## 2. Install

### Option A — `npx` (no install)

Nothing to install; your MCP client can launch Multicode on demand:

```bash
npx -y multicode --version
```

This is the form used in every client config below.

### Option B — global install

```bash
npm install -g multicode
# or: pnpm add -g multicode
multicode --version
```

With a global install, replace `npx -y multicode` with just `multicode` in any config below.

### Option C — from source (for contributors)

```bash
git clone https://github.com/multicode/multicode
cd multicode
corepack enable
pnpm install
pnpm build
# The binary is now at packages/cli/dist/bin/multicode.js
node packages/cli/dist/bin/multicode.js --version
# Optionally link it onto your PATH as `multicode`:
npm link -w multicode
```

## 3. First-time setup

Run these once:

```bash
# 1. Create the data dir (~/.multicode) and a starter config
npx -y multicode init

# 2. Log in to a provider using ITS OWN login flow.
#    For Codex this launches `codex login` — Multicode never sees or stores the token.
npx -y multicode provider login codex

# 3. Verify everything is wired up
npx -y multicode doctor
```

`doctor` checks Node, git, your config, each configured provider's load + auth status, and that your
**workspace roots** exist and are Git repositories. A task can only run inside an approved workspace
root; `init` approves the current directory. Add more by editing `~/.multicode/config.json` (see
[§6](#6-configuration-reference)) and re-running `multicode config validate`.

## 4. Add Multicode to your MCP client

Multicode is launched by your client over **stdio** with `command: npx` and
`args: ["-y", "multicode", "serve"]`. The *wrapper* around that differs per client — most use an
`mcpServers` object, but **VS Code uses `servers` + `type`** and **Zed uses `context_servers`**.

> [!NOTE]
> **Windows (applies to every client):** some clients don't spawn through a shell, so bare `npx` can
> fail. If a server won't start, wrap it as `"command": "cmd"`, `"args": ["/c", "npx", "-y",
> "multicode", "serve"]` (or use `"npx.cmd"`), and make sure Node/npm are on `PATH`. WSL uses plain
> `npx`.

> [!IMPORTANT]
> **Restart or reload the client** after editing its config so it re-reads the server list.

| Client | How to add | Top-level key | Config file |
|---|---|---|---|
| [Claude Code](#claude-code) | `claude mcp add` CLI or `.mcp.json` | `mcpServers` | `.mcp.json` / `~/.claude.json` |
| [Claude Desktop](#claude-desktop) | Settings → Developer → Edit Config | `mcpServers` | `claude_desktop_config.json` |
| [Cursor](#cursor) | `mcp.json` or Settings → Tools & MCP | `mcpServers` | `~/.cursor/mcp.json` |
| [Windsurf](#windsurf) | `mcp_config.json` or Cascade → Plugins | `mcpServers` | `~/.codeium/windsurf/mcp_config.json` |
| [VS Code (Copilot)](#vs-code-github-copilot) | `.vscode/mcp.json` or `code --add-mcp` | **`servers`** | `.vscode/mcp.json` |
| [Zed](#zed) | Settings → AI → MCP Servers | **`context_servers`** | `~/.config/zed/settings.json` |
| [Cline](#cline-vs-code-extension) | MCP Servers → Configure | `mcpServers` | `cline_mcp_settings.json` |
| [Continue](#continue) | `.continue/…/*.yaml` | `mcpServers` (YAML) | `~/.continue/config.yaml` |
| [Gemini CLI](#gemini-cli) | `gemini mcp add` or `settings.json` | `mcpServers` | `~/.gemini/settings.json` |
| [Any other client](#any-other-mcp-client) | canonical `mcpServers` block | `mcpServers` | (client-specific) |

### Claude Code

Fastest — one command (the `--` is required; it separates Claude's flags from the launch command):

```bash
claude mcp add --scope user --transport stdio multicode -- npx -y multicode serve
```

Or commit a **project-scoped** `.mcp.json` at the repo root so teammates get it too:

```json
{
  "mcpServers": {
    "multicode": { "type": "stdio", "command": "npx", "args": ["-y", "multicode", "serve"] }
  }
}
```

Scopes: `user` (all your projects, in `~/.claude.json`), `project` (`.mcp.json`, committable —
teammates approve on first use), `local` (just you, this project). Verify with `claude mcp list`;
manage at runtime with `/mcp`. Claude Code can also register a **genuinely remote** HTTP server:
`claude mcp add --transport http multicode <url> --header "Authorization: Bearer <token>"` (see
[§5](#5-remote--http-transport)).

### Claude Desktop

No CLI. Open the **Claude menu in the OS menu bar → Settings… → Developer → Edit Config**, then add:

```json
{
  "mcpServers": {
    "multicode": { "command": "npx", "args": ["-y", "multicode", "serve"] }
  }
}
```

Config file: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) ·
`%APPDATA%\Claude\claude_desktop_config.json` (Windows). **Fully quit and restart** Claude Desktop
afterward. This config only launches *local* stdio servers (no remote URL field); logs live at
`~/Library/Logs/Claude/mcp*.log` (macOS) or `%APPDATA%\Claude\logs` (Windows).

### Cursor

Create `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project root), or use **Settings → Tools &
MCP → Add Custom MCP**:

```json
{
  "mcpServers": {
    "multicode": { "type": "stdio", "command": "npx", "args": ["-y", "multicode", "serve"] }
  }
}
```

Then confirm the server shows green/connected in Settings → Tools & MCP.

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json` (or Cascade → the hammer/tools icon → **Manage plugins →
View raw config**):

```json
{
  "mcpServers": {
    "multicode": { "command": "npx", "args": ["-y", "multicode", "serve"] }
  }
}
```

Press the **refresh** button in the MCP/plugins panel after saving.

### VS Code (GitHub Copilot)

> [!WARNING]
> VS Code is different: it uses the **`servers`** key (not `mcpServers`) and requires an explicit
> **`type`**.

Create `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "multicode": { "type": "stdio", "command": "npx", "args": ["-y", "multicode", "serve"] }
  }
}
```

Or run the CLI (adds it to your user profile):

```bash
code --add-mcp '{"name":"multicode","command":"npx","args":["-y","multicode","serve"]}'
```

Requires **GitHub Copilot Chat in Agent mode** — MCP tools aren't exposed in Ask/Edit mode. `mcp.json`
shows a start/restart CodeLens to (re)launch the server.

### Zed

> [!WARNING]
> Zed uses the **`context_servers`** key.

Open settings (Command Palette → `zed: open settings`) or **Settings → AI → MCP Servers → Add Local
Server**, and add:

```json
{
  "context_servers": {
    "multicode": { "command": "npx", "args": ["-y", "multicode", "serve"], "env": {} }
  }
}
```

Zed reloads on save; the dot next to the server turns green when it's active. On Windows use
`"command": "npx.cmd"` if bare `npx` fails.

### Cline (VS Code extension)

In the Cline panel, click the **MCP Servers** icon → **Configure MCP Servers** to open
`cline_mcp_settings.json`, then add:

```json
{
  "mcpServers": {
    "multicode": {
      "command": "npx",
      "args": ["-y", "multicode", "serve"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Cline watches the file and reloads on save (or toggle the server off/on in the panel).

### Continue

Continue uses **YAML**. Create `.continue/mcpServers/multicode.yaml` (workspace) or add the list item
to `~/.continue/config.yaml` under `mcpServers:`:

```yaml
name: Multicode
version: 0.0.1
schema: v1
mcpServers:
  - name: multicode
    command: npx
    args:
      - "-y"
      - "multicode"
      - "serve"
```

MCP tools are available only in **Agent mode**.

### Gemini CLI

```bash
gemini mcp add multicode npx -- -y multicode serve   # add -s user for a global (~/.gemini) install
```

The `--` separates Gemini's own flags from the server's args. Or edit `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "multicode": { "command": "npx", "args": ["-y", "multicode", "serve"] }
  }
}
```

Restart the CLI after a manual edit; check status with `/mcp` in an interactive session.

### Any other MCP client

The near-universal shape is a `mcpServers` map of `command` + `args`:

```json
{
  "mcpServers": {
    "multicode": { "command": "npx", "args": ["-y", "multicode", "serve"], "env": {} }
  }
}
```

If your client speaks **Streamable HTTP** instead of launching a process, run Multicode in HTTP mode
([§5](#5-remote--http-transport)) and point the client at `http://127.0.0.1:7461/mcp` with an
`Authorization: Bearer` header.

## 5. Remote / HTTP transport

Most clients launch Multicode locally over **stdio** (the default, and what §4 uses). Multicode can
also serve over **Streamable HTTP** for controlled remote/shared access.

1. Configure the transport in `~/.multicode/config.json`:

   ```jsonc
   {
     "transport": {
       "type": "http",
       "host": "127.0.0.1",      // loopback by default
       "port": 7461,
       "path": "/mcp",
       "authTokenEnv": "MULTICODE_TOKEN"  // REQUIRED for any non-loopback host
     }
   }
   ```

2. Export the token and start the server:

   ```bash
   export MULTICODE_TOKEN="$(openssl rand -hex 32)"
   npx -y multicode serve --transport http
   ```

3. Point an HTTP-capable MCP client at `http://127.0.0.1:7461/mcp` with header
   `Authorization: Bearer $MULTICODE_TOKEN`.

**Hardening (always on):** loopback bind by default; a bearer token is **required** when binding to a
non-loopback host (enforced by config validation); DNS-rebinding protection via `allowedHosts` /
`allowedOrigins`; requests are stateless (durable state lives in the store). See
[`security.md`](./security.md).

## 6. Configuration reference

Config lives at `~/.multicode/config.json` (override with `--config <path>` or the `MULTICODE_HOME`
env var). Validate it any time with `multicode config validate`; print its path with
`multicode config path`.

```jsonc
{
  "version": 1,
  "dataDir": "~/.multicode",          // SQLite DB, worktrees, artifacts, logs
  "workspaceRoots": ["/abs/path/to/your/project"],  // tasks may only run here
  "defaults": {
    "mode": "read_only",              // read_only | write
    "sandbox": "read_only",           // read_only | workspace_write | danger_full_access
    "network": "disabled",            // disabled | restricted | enabled
    "approvals": "on_request",        // never | on_request | on_failure | auto
    "limits": { "timeoutMs": 1800000, "cancelGraceMs": 10000, "maxOutputBytes": 33554432, "maxEvents": 250000 }
  },
  "providers": {
    "codex": { "enabled": true, "args": ["app-server"], "passthroughEnv": ["PATH", "HOME", "CODEX_HOME"] }
  },
  "transport": { "type": "stdio" },
  "logging": { "level": "info", "pretty": false }
}
```

Per-task overrides (sandbox, network, approvals, timeout) are also accepted as arguments to the
`multicode_start_task` tool.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Client shows no Multicode tools | Fully **restart** the client after editing its config. Confirm the command runs: `npx -y multicode serve` should start and wait on stdin. |
| `No Multicode config found … run multicode init` | Run `npx -y multicode init`, or pass `--config <path>`. |
| `provider "codex" is failed` in `doctor` | Ensure the `codex` CLI is on `PATH` and `codex app-server` works. Check `passthroughEnv` includes `PATH`/`HOME`. |
| `not logged in` | `npx -y multicode provider login codex` (reuses Codex's own login). |
| `Requested workspace root is not within any approved root` | Add the path to `workspaceRoots` in the config and `multicode config validate`. |
| `Write tasks require … a Git repository` | Write tasks need the workspace root to be a git repo. `git init` it, or use `mode: read_only`. |
| Windows: server won't launch via `npx` | Some clients need `cmd /c npx -y multicode serve`, or use a global install and the bare `multicode` command. See the per-client notes in §4. |
| Logs pollute the MCP stream | They shouldn't — Multicode logs to **stderr**, never stdout. If you see JSON on stderr, that's expected; set `logging.level` to `warn` to quiet it. |

Enable verbose logging with `"logging": { "level": "debug" }` (written to stderr; the server also
accepts `"logging": { "file": "/path/to/multicode.log" }`).

## 8. Uninstall

1. Remove the server entry from your MCP client config (delete the `multicode` block or run the
   client's remove command, e.g. `claude mcp remove multicode`).
2. Uninstall the package: `npm uninstall -g multicode` (if globally installed).
3. Delete state: `rm -rf ~/.multicode`.
4. Provider credentials belong to the provider — remove them with the provider's own tooling
   (e.g. `codex logout`).
