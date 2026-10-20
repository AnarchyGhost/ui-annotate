import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts", index: "src/index.ts", hook: "src/hooks/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: { entry: { index: "src/index.ts" } },
  clean: true,
  // `sqlite` exists only as `node:sqlite`; stripping the prefix breaks the import.
  removeNodeProtocol: false,
  // The private protocol package is inlined; the published package depends only on the MCP SDK and zod.
  noExternal: ["@ui-annotate/protocol"],
  banner: { js: "#!/usr/bin/env node" },
});
