import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Root Vitest configuration.
 *
 * Tests run against each package's TypeScript *source* (not built `dist/`) so the suite works without
 * a prior `pnpm build`. Cross-package imports like `@multicode/core` are aliased to the package's
 * source below. Subpath aliases (e.g. `@multicode/provider-sdk/testing`) are listed *before* the bare
 * package alias so they win the prefix match.
 */
const pkg = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: '@multicode/provider-sdk/conformance', replacement: pkg('./packages/provider-sdk/src/conformance/index.ts') },
      { find: '@multicode/provider-sdk/testing', replacement: pkg('./packages/provider-sdk/src/testing/index.ts') },
      { find: '@multicode/core', replacement: pkg('./packages/core/src/index.ts') },
      { find: '@multicode/persistence', replacement: pkg('./packages/persistence/src/index.ts') },
      { find: '@multicode/security', replacement: pkg('./packages/security/src/index.ts') },
      { find: '@multicode/provider-sdk', replacement: pkg('./packages/provider-sdk/src/index.ts') },
      { find: '@multicode/server', replacement: pkg('./packages/server/src/index.ts') },
      { find: '@multicode/provider-codex', replacement: pkg('./packages/providers/codex/src/index.ts') },
      { find: '@multicode/provider-ollama', replacement: pkg('./packages/providers/ollama/src/index.ts') },
      { find: '@multicode/cli', replacement: pkg('./packages/cli/src/index.ts') },
    ],
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/**/*.{test,spec}.ts'],
    exclude: ['**/dist/**', '**/node_modules/**'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'packages/providers/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/index.ts', '**/test/**'],
    },
  },
});
