import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import Inspector from "vite-plugin-vue-inspector";

export default defineConfig({
  plugins: [vue(), Inspector({ enabled: false, toggleButtonVisibility: "never" })],
  server: { port: 5102, strictPort: true, host: "127.0.0.1" },
});
