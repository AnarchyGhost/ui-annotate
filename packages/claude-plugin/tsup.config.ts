import { defineConfig } from "tsup";

/**
 * The plugin ships one self-contained CLI: Claude Code may run the plugin from a copy in its
 * cache, where the workspace node_modules are not reachable.
 */
export default defineConfig({
  entry: { cli: "../server/src/cli.ts" },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  noExternal: [/.*/],
  removeNodeProtocol: false,
  splitting: false,
  banner: {
    // CommonJS dependencies of the MCP SDK call require() on Node builtins.
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
});
