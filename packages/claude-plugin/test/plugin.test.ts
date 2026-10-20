import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HOOK_CONTEXT_LIMIT } from "@ui-annotate/protocol";
import { loadConfig, startDaemon, type Config } from "ui-annotate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LAUNCHER = join(ROOT, "bin", "ui-annotate");
const fixture = (name: string) => readFileSync(join(ROOT, "test", "fixtures", `${name}.json`), "utf8");

let dir: string;
let env: NodeJS.ProcessEnv;
let config: Config;
let daemon: Awaited<ReturnType<typeof startDaemon>>;

async function call(path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.json() as Promise<{ id: string }>;
}

function runHook(event: string, stdin: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile(LAUNCHER, ["hook", "claude", event], { env: { ...env, ...extraEnv } }, (error, stdout) => {
      resolve({ stdout, code: error ? Number(error.code ?? 1) : 0 });
    });
    child.stdin!.end(stdin);
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ui-annotate-plugin-"));
  env = {
    ...process.env,
    UI_ANNOTATE_PORT: String(47_000 + Math.floor(Math.random() * 1000)),
    UI_ANNOTATE_DB: join(dir, "db.sqlite"),
    UI_ANNOTATE_TOKEN_FILE: join(dir, "token"),
  };
  config = loadConfig(env);
  daemon = await startDaemon(config);
});

afterAll(async () => {
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("manifests", () => {
  it("declare the MCP server, hooks and channel consistently", () => {
    const plugin = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
    const mcp = JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8"));
    const hooks = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));
    const marketplace = JSON.parse(readFileSync(join(ROOT, "..", "..", ".claude-plugin", "marketplace.json"), "utf8"));
    expect(Object.keys(mcp.mcpServers)).toEqual(["ui-annotate"]);
    expect(plugin.channels).toEqual([{ server: "ui-annotate", displayName: "ui-annotate" }]);
    expect(Object.keys(hooks.hooks).sort()).toEqual(["SessionStart", "Stop", "UserPromptSubmit"]);
    expect(marketplace.plugins[0]).toMatchObject({ name: plugin.name, source: "./packages/claude-plugin" });
  });
});

describe("hooks through bin/ui-annotate", () => {
  it("stay silent while nothing is open", async () => {
    for (const [event, name] of [["SessionStart", "session-start"], ["UserPromptSubmit", "user-prompt-submit"], ["Stop", "stop"]]) {
      expect(await runHook(event!, fixture(name!))).toEqual({ stdout: "", code: 0 });
    }
  });

  it("only count annotations of pages without a project root", async () => {
    const session = await call("/sessions", { url: "http://localhost:5199/rootless", title: "Rootless" });
    const annotation = await call(`/sessions/${session.id}/annotations`, {
      kind: "element",
      comment: "Rootless page",
      targets: [{ element: "p", selector: "p", elementPath: "p", boundingBox: { x: 0, y: 0, width: 1, height: 1 }, source: {} }],
      url: "http://localhost:5199/rootless",
      viewport: { width: 1, height: 1 },
    });
    const start = JSON.parse((await runHook("SessionStart", fixture("session-start"))).stdout);
    expect(start.hookSpecificOutput.additionalContext).toMatch(/1 open annotation\(s\) from pages without a project root/);
    expect(start.hookSpecificOutput.additionalContext).not.toContain("Rootless page");
    expect(await runHook("Stop", fixture("stop"))).toEqual({ stdout: "", code: 0 });
    await call(`/annotations/${annotation.id}/actions`, { action: "dismiss", reason: "test cleanup" });
  });

  it("inject the digest and block Stop once an annotation of this project is open", async () => {
    // Fixtures send cwd /work/app.
    const session = await call("/sessions", { url: "http://localhost:5173/", title: "App", projectRoot: "/work/app" });
    const annotation = await call(`/sessions/${session.id}/annotations`, {
      kind: "element",
      comment: "Save button overlaps the title",
      targets: [
        {
          element: 'button "Save"',
          selector: '[data-testid="save"]',
          elementPath: "header.toolbar > button",
          boundingBox: { x: 0, y: 0, width: 10, height: 10 },
          source: { framework: "vue", componentName: "AppToolbar", file: "src/components/AppToolbar.vue", line: 8, column: 5 },
        },
      ],
      url: "http://localhost:5173/",
      viewport: { width: 1280, height: 800 },
    });

    const start = await runHook("SessionStart", fixture("session-start"));
    const startOutput = JSON.parse(start.stdout);
    expect(startOutput.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(startOutput.hookSpecificOutput.additionalContext).toContain("`src/components/AppToolbar.vue:8:5` `<AppToolbar>`");
    expect(startOutput.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(HOOK_CONTEXT_LIMIT);

    const prompt = JSON.parse((await runHook("UserPromptSubmit", fixture("user-prompt-submit"))).stdout);
    expect(prompt.hookSpecificOutput).toMatchObject({ hookEventName: "UserPromptSubmit" });
    expect(prompt.hookSpecificOutput.additionalContext).toContain(`id=${annotation.id}`);

    expect(JSON.parse((await runHook("Stop", fixture("stop"))).stdout)).toEqual({ decision: "block", reason: expect.stringContaining("1 open") });
    expect(await runHook("Stop", fixture("stop-active"))).toEqual({ stdout: "", code: 0 });
    // A background run of automatic mode has the annotations in its prompt.
    expect(await runHook("SessionStart", fixture("session-start"), { UI_ANNOTATE_DISPATCH: "1" })).toEqual({ stdout: "", code: 0 });
    expect(await runHook("Stop", fixture("stop"), { UI_ANNOTATE_DISPATCH: "1" })).toEqual({ stdout: "", code: 0 });
  });

  it("fail open when the daemon is unreachable", async () => {
    expect(await runHook("Stop", fixture("stop"), { UI_ANNOTATE_PORT: "1" })).toEqual({ stdout: "", code: 0 });
  });

  it("fail open when no suitable Node.js exists", async () => {
    const result = await runHook("Stop", fixture("stop"), { PATH: "/nonexistent", HOME: dir, UI_ANNOTATE_NODE: "/usr/bin/false" });
    expect(result).toEqual({ stdout: "", code: 0 });
  });
});

describe("bundled MCP server", () => {
  it("starts through the launcher with the channel capability", async () => {
    const client = new Client({ name: "plugin-test", version: "0" });
    await client.connect(new StdioClientTransport({ command: LAUNCHER, args: ["mcp", "--channel"], env: env as Record<string, string> }));
    try {
      expect(client.getServerCapabilities()?.experimental).toEqual({ "claude/channel": {} });
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("get_pending");
    } finally {
      await client.close();
    }
  });

  it("pushes a channel notification for a new annotation", async () => {
    const client = new Client({ name: "plugin-test", version: "0" });
    const received = new Promise<{ content: string; meta: Record<string, string> }>((resolve) => {
      client.fallbackNotificationHandler = async (notification) => {
        if (notification.method === "notifications/claude/channel") resolve(notification.params as never);
      };
    });
    await client.connect(new StdioClientTransport({ command: LAUNCHER, args: ["mcp", "--channel"], env: env as Record<string, string>, cwd: dir }));
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      // Rootless page first: the channel must not push it, then this project's page.
      const rootless = await call("/sessions", { url: "http://localhost:5199/channel-rootless", title: "" });
      await call(`/sessions/${rootless.id}/annotations`, {
        kind: "element",
        comment: "Not for this project",
        targets: [{ element: "p", selector: "p", elementPath: "p", boundingBox: { x: 0, y: 0, width: 1, height: 1 }, source: {} }],
        url: "http://localhost:5199/channel-rootless",
        viewport: { width: 1, height: 1 },
      });
      const session = await call("/sessions", { url: "http://localhost:5173/channel", title: "Channel", projectRoot: dir });
      const annotation = await call(`/sessions/${session.id}/annotations`, {
        kind: "element",
        comment: "Pushed live",
        targets: [{ element: "p", selector: "p", elementPath: "p", boundingBox: { x: 0, y: 0, width: 1, height: 1 }, source: {} }],
        url: "http://localhost:5173/channel",
        viewport: { width: 1, height: 1 },
      });
      const params = await received;
      expect(params.content).toContain("Pushed live");
      expect(params.meta).toMatchObject({ annotation_id: annotation.id, session_id: session.id });
    } finally {
      await client.close();
    }
  });
});
