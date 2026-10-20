import { defineConfig } from "@playwright/test";
import e2e from "./playwright.config";

/** README screenshots of examples/demo: `pnpm screenshots` (needs `pnpm build`), output in docs/images. */
const [daemon] = [e2e.webServer ?? []].flat();

export default defineConfig({
  ...e2e,
  testDir: "screenshots",
  webServer: [
    daemon!,
    {
      command: "pnpm dev",
      cwd: "../../examples/demo",
      url: "http://127.0.0.1:5180/",
      reuseExistingServer: true,
      timeout: 60_000,
      stdout: "ignore",
    },
  ],
});
