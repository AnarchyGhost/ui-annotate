import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import Inspector from "vite-plugin-vue-inspector";

// The inspector plugin adds template lines to elements; ui-annotate reads them for file:line.
export default defineConfig({
  plugins: [vue(), Inspector({ enabled: false, toggleButtonVisibility: "never" })],
  server: { port: 5180, strictPort: true, host: "127.0.0.1" },
});
