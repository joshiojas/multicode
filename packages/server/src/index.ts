/**
 * `@multicode/server` — the provider-neutral MCP server and task orchestrator. It owns the tool
 * surface, the durable task lifecycle, event streaming, approvals, verification, recovery, and both
 * transports. It never imports a concrete provider; the composition root registers providers on a
 * {@link ProviderRegistry} and hands it in.
 */
export { Orchestrator, type OrchestratorDeps, type RecoverySummary } from './orchestrator/orchestrator.js';
export { RunManager } from './orchestrator/run-manager.js';
export { ApprovalCoordinator } from './orchestrator/approvals.js';
export { buildVerification } from './orchestrator/verification.js';

export { createMcpServer, SERVER_NAME, SERVER_VERSION } from './mcp/server.js';
export { registerTools } from './mcp/tools.js';
export { ok, fail, guard, type ToolResult } from './mcp/errors.js';

export { serveStdio } from './transport/stdio.js';
export { serveHttp, type HttpServeOptions } from './transport/http.js';

export { createLogger } from './logging.js';
export {
  bootstrap,
  providerSpecsFromConfig,
  type BootstrapOptions,
  type BootstrapResult,
} from './bootstrap.js';
