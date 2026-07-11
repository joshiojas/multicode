# @multicode/provider-ollama

An [Ollama](https://ollama.com) provider for [Multicode](https://github.com/joshiojas/multicode) —
delegate coding tasks to a **local model** (e.g. `gemma`, `llama`, `qwen`) running on your own machine.

It exists both as a useful local-model backend and as a demonstration that Multicode's provider SDK is
genuinely **model-agnostic**: a raw LLM endpoint plugs in exactly like the Codex App Server.

## How it works

This is a **codegen** provider: it prompts the model (via Ollama's `/api/chat` with JSON output) for a
structured set of file writes, then applies them **into the task's confined Git worktree** — it never
runs untrusted shell commands, and Multicode's real `git diff` remains the ground truth. Small models
occasionally emit malformed JSON, so the adapter tolerates fences/prose and retries once.

## Use it

`ollama` is a built-in provider in the Multicode CLI. Enable it in `~/.multicode/config.json` (requires
a running Ollama server):

```jsonc
{
  "providers": {
    "ollama": {
      "enabled": true,
      "config": { "model": "gemma4:latest", "baseUrl": "http://localhost:11434" }
    }
  }
}
```

Then delegate as usual — e.g. via the MCP tool `multicode_start_task` with `providerId: "ollama"`,
`mode: "write"`, and `sandbox: "workspace_write"`.

## Capabilities

Streaming, resume, cancellation, read-only + write modes, structured results. It does **not** raise
approvals or support steering (it writes model-produced files directly), and only ever writes within
the worktree.

Licensed under Apache-2.0.
