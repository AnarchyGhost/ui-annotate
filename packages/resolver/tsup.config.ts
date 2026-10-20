import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: true,
    clean: true,
  },
  {
    // Injected into the page MAIN world by the extension: one self-contained IIFE.
    entry: { main: "src/main.ts" },
    format: ["iife"],
    globalName: "__uiAnnotateResolver",
    noExternal: [/.*/],
    minify: false,
    platform: "browser",
  },
]);
