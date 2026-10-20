import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import devtools from "solid-devtools/vite";

export default defineConfig({
  plugins: [devtools({ locator: { jsxLocation: true, componentLocation: true } }), solid()],
  server: { port: 5108, strictPort: true, host: "127.0.0.1" },
});
