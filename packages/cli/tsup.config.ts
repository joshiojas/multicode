import { defineConfig } from 'tsup';

/**
 * Bundle the CLI into a single self-contained ESM binary for publishing as `multicode-mcp`.
 *
 * The internal `@multicode/*` workspace packages are bundled in (`noExternal`), so the published
 * package has no unpublished dependencies. Real npm dependencies (better-sqlite3 — native — plus the
 * MCP SDK, pino, commander, zod) are declared in `dependencies` and left external, so npm installs them
 * normally. Requires `pnpm build` first (tsup resolves the built `dist` of each workspace package).
 */
export default defineConfig({
  entry: { multicode: 'src/bin/multicode.ts' },
  outDir: 'dist/bundle',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  bundle: true,
  splitting: false,
  clean: true,
  sourcemap: false,
  dts: false,
  shims: false,
  // Bundle the internal workspace packages; everything in `dependencies` stays external.
  // The shebang is preserved from the source entry file (src/bin/multicode.ts), so no banner here.
  noExternal: [/^@multicode\//],
});
