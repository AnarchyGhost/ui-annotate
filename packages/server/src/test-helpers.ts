import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnnotationInput } from "@ui-annotate/protocol";
import { loadConfig, type Config } from "./config.js";
import { startDaemon, type RunningDaemon } from "./daemon.js";
import type { DispatcherOptions } from "./dispatch.js";
import type { LiveClientsOptions } from "./live-clients.js";

export const EXTENSION_ORIGIN = "chrome-extension://pimhfahcdpnkbmflgggigkfdjolgemom";

export function annotationInput(overrides: Partial<AnnotationInput> = {}): AnnotationInput {
  return {
    kind: "element",
    comment: "Save button is misaligned",
    targets: [
      {
        element: 'button "Save"',
        selector: "[data-testid=save]",
        elementPath: "main.layout > header.toolbar > button.primary",
        nearbyText: "Save",
        boundingBox: { x: 10, y: 10, width: 60, height: 24 },
        source: {
          framework: "vue",
          componentName: "AppToolbar",
          file: "/work/app/src/components/AppToolbar.vue",
          line: 8,
          column: 5,
          via: "attribute",
          attribute: "data-v-inspector",
          stack: [],
        },
      },
    ],
    url: "http://localhost:5173/settings",
    viewport: { width: 1280, height: 800 },
    ...overrides,
  };
}

export interface TestDaemon {
  config: Config;
  daemon: RunningDaemon;
  url: string;
  env: NodeJS.ProcessEnv;
  dir: string;
  /** fetch with the token and extension headers unless overridden. */
  call(path: string, init?: RequestInit & { json?: unknown }): Promise<Response>;
  close(): Promise<void>;
}

/**
 * A port the OS reports free right now. Test files run in parallel, so fixed or offset ranges
 * collide; the short window between close and the daemon's listen is the remaining risk.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export async function startTestDaemon(dispatch: DispatcherOptions = {}, live: LiveClientsOptions = {}): Promise<TestDaemon> {
  const dir = mkdtempSync(join(tmpdir(), "ui-annotate-test-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    UI_ANNOTATE_PORT: String(await freePort()),
    UI_ANNOTATE_DB: join(dir, "db.sqlite"),
    UI_ANNOTATE_TOKEN_FILE: join(dir, "token"),
  };
  const config = loadConfig(env);
  const daemon = await startDaemon(config, dispatch, { sessionsDir: join(dir, "claude-sessions"), ...live });
  const url = `http://127.0.0.1:${config.port}`;
  return {
    config,
    daemon,
    url,
    env,
    dir,
    call: (path, init = {}) => {
      const { json, headers, ...rest } = init;
      return fetch(`${url}${path}`, {
        ...rest,
        headers: {
          authorization: `Bearer ${daemon.token}`,
          origin: EXTENSION_ORIGIN,
          ...(json === undefined ? {} : { "content-type": "application/json" }),
          ...(headers as Record<string, string> | undefined),
        },
        body: json === undefined ? rest.body : JSON.stringify(json),
      });
    },
    close: async () => {
      await daemon.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
