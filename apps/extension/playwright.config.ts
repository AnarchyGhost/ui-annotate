import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

export const E2E_PORT = 4949;
// Created once in the runner process; workers inherit the variable and share the directory.
process.env.UI_ANNOTATE_E2E_DIR ??= mkdtempSync(join(tmpdir(), "ui-annotate-e2e-"));
export const E2E_DIR = process.env.UI_ANNOTATE_E2E_DIR;

const FIXTURES = ["vue3", "vue3-inspector", "react18", "react19", "svelte4", "svelte5", "angular", "solid"] as const;

const fixtureServers = FIXTURES.map((name) => {
  const { url } = JSON.parse(readFileSync(new URL(`../../fixtures/${name}/expected.json`, import.meta.url), "utf8")) as { url: string };
  return {
    command: "pnpm dev",
    cwd: `../../fixtures/${name}`,
    url,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "ignore" as const,
  };
});

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  webServer: [
    {
      command: "node ../../packages/server/dist/cli.js serve",
      url: `http://127.0.0.1:${E2E_PORT}/health`,
      reuseExistingServer: false,
      env: {
        UI_ANNOTATE_PORT: String(E2E_PORT),
        UI_ANNOTATE_DB: join(E2E_DIR, "db.sqlite"),
        UI_ANNOTATE_TOKEN_FILE: join(E2E_DIR, "token"),
        // Automatic mode runs this stand-in instead of the real Codex CLI.
        UI_ANNOTATE_CODEX_BIN: fileURLToPath(new URL("e2e/fake-agent.mjs", import.meta.url)),
      },
      timeout: 20_000,
    },
    ...fixtureServers,
  ],
});
