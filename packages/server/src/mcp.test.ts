import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ServerEvent } from "@ui-annotate/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpApi } from "./client.js";
import { annotationInput, freePort, startTestDaemon, type TestDaemon } from "./test-helpers.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const TOOLS = ["acknowledge", "dismiss", "get_annotation", "get_pending", "link_page", "list_sessions", "reply", "resolve", "watch_annotations"];

let t: TestDaemon;
let client: Client;
beforeEach(async () => {
  t = await startTestDaemon();
});
afterEach(async () => {
  await client?.close();
  await t.close();
});

const textOf = (result: unknown) => ((result as { content: Array<{ text: string }> }).content[0]?.text ?? "");

async function seed() {
  const session = (await (
    await t.call("/sessions", { method: "POST", json: { url: "http://localhost:5173/settings", title: "Settings", projectRoot: "/work/app" } })
  ).json()) as { id: string };
  const annotation = await (await t.call(`/sessions/${session.id}/annotations`, { method: "POST", json: annotationInput() })).json();
  return { session, annotation } as { session: { id: string }; annotation: { id: string } };
}

describe("stdio MCP proxy (built CLI)", () => {
  beforeEach(async () => {
    client = new Client({ name: "test", version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env: t.env as Record<string, string>, stderr: "pipe" }));
  });

  it("lists all tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOLS);
  });

  it("runs annotation → get_pending → reply → resolve and the subscriber sees SSE events", async () => {
    const events: ServerEvent[] = [];
    const unsubscribe = new HttpApi(t.url, t.daemon.token).subscribe((event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const { annotation } = await seed();

    const pending = textOf(await client.callTool({ name: "get_pending", arguments: {} }));
    expect(pending.split("\n")[0]).toBe("count: 1");
    // Trust note, then the block whose first line is the path relative to session.projectRoot.
    const lines = pending.split("\n");
    expect(lines[1]).toMatch(/^Trust: /);
    expect(lines[3]).toMatch(/^`src\/components\/AppToolbar\.vue:8:5` `<AppToolbar>`/);

    await client.callTool({ name: "reply", arguments: { id: annotation.id, message: "Moving it 4px left" } });
    const resolved = textOf(await client.callTool({ name: "resolve", arguments: { id: annotation.id, summary: "Aligned with the title" } }));
    expect(resolved).toContain("[resolved]");

    await new Promise((resolve) => setTimeout(resolve, 300));
    unsubscribe();
    expect(events.map((event) => event.type)).toEqual(["annotation.created", "annotation.updated", "annotation.updated"]);
    const last = events.at(-1);
    expect(last?.type === "annotation.updated" && last.annotation.thread.map((message) => message.kind)).toEqual(["reply", "resolve"]);

    const after = textOf(await client.callTool({ name: "get_pending", arguments: {} }));
    expect(after.split("\n")[0]).toBe("count: 0");
  });

  it("returns watch_annotations batches and timeouts", async () => {
    const timedOut = textOf(await client.callTool({ name: "watch_annotations", arguments: { timeoutSeconds: 1 } }));
    expect(JSON.parse(timedOut)).toEqual({ timeout: true });

    const watching = client.callTool({ name: "watch_annotations", arguments: { timeoutSeconds: 5 } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await seed();
    expect(textOf(await watching)).toMatch(/^new: 1/);
  });

  it("returns annotations created between two watch calls on the next call", async () => {
    await seed();
    const first = textOf(await client.callTool({ name: "watch_annotations", arguments: { timeoutSeconds: 2 } }));
    expect(first).toMatch(/^new: 1/);
    // Created while the agent was busy, no watch call pending.
    await seed();
    const started = Date.now();
    const second = textOf(await client.callTool({ name: "watch_annotations", arguments: { timeoutSeconds: 5 } }));
    expect(second).toMatch(/^new: 1/);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("drops source paths outside the project", async () => {
    const session = (await (await t.call("/sessions", { method: "POST", json: { url: "http://localhost:5173/x", title: "", projectRoot: "/work/app" } })).json()) as {
      id: string;
    };
    const input = annotationInput();
    input.targets[0]!.source = { ...input.targets[0]!.source, file: "../../home/u/.ssh/id_rsa", line: 1, column: 1 };
    await t.call(`/sessions/${session.id}/annotations`, { method: "POST", json: input });
    const pending = textOf(await client.callTool({ name: "get_pending", arguments: { sessionId: session.id } }));
    expect(pending).not.toContain("id_rsa");
    expect(pending).toContain("source note: outside-project");
  });

  it("link_page ties a page to the repository of the agent's working directory", async () => {
    // The stdio client runs in the test process cwd: this repository (packages/server).
    const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
    const result = textOf(await client.callTool({ name: "link_page", arguments: { url: "http://localhost:5173/app/" } }));
    expect(result).toBe(`Linked http://localhost:5173/app/ to ${repoRoot} (source: agent).`);
  });

  it("reports tool errors without crashing", async () => {
    const result = await client.callTool({ name: "resolve", arguments: { id: "a_missing", summary: "x" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not found");
  });
});

describe("process lifetime", () => {
  it("exits when stdin closes, also in channel mode", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [CLI, "mcp", "--channel"], { env: t.env, stdio: ["pipe", "pipe", "pipe"] });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    child.stdin.end();
    const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("still running"), 3000))]);
    if (code === "still running") child.kill();
    expect(code).toBe(0);
  });
});

describe("outdated daemon", () => {
  it("is replaced by the current one when an MCP client starts", async () => {
    const { spawn, execFileSync } = await import("node:child_process");
    const port = await freePort();
    // Health of a daemon from before API level 2: no `api` field.
    const old = spawn(process.execPath, [
      "-e",
      `require("node:http").createServer((q, s) => { s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ ok: true, name: "ui-annotate", version: "0.1.0", pid: process.pid })); }).listen(${port}, "127.0.0.1");`,
    ]);
    const oldExited = new Promise((resolve) => old.once("exit", resolve));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const env = { ...t.env, UI_ANNOTATE_PORT: String(port) } as Record<string, string>;
    client = new Client({ name: "test", version: "0" });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" }));
      await oldExited;
      const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { api: number; pid: number };
      expect(health.api).toBe(5);
      expect(health.pid).not.toBe(old.pid);
      expect((await client.listTools()).tools).toHaveLength(TOOLS.length);
    } finally {
      old.kill();
      await client.close();
      execFileSync("fuser", ["-k", `${port}/tcp`], { stdio: "ignore" });
    }
  });
});

describe("daemon autostart", () => {
  it("starts the daemon when none is running", async () => {
    const port = await freePort();
    const env = { ...t.env, UI_ANNOTATE_PORT: String(port) } as Record<string, string>;
    client = new Client({ name: "test", version: "0" });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" }));
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(TOOLS.length);
      const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      expect(health).toMatchObject({ ok: true });
    } finally {
      await client.close();
      const { execFileSync } = await import("node:child_process");
      execFileSync("fuser", ["-k", `${port}/tcp`], { stdio: "ignore" });
    }
  });
});

describe("Streamable HTTP MCP on /mcp", () => {
  it("serves the same tools behind the token", async () => {
    client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${t.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${t.daemon.token}` } },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOLS);
    await seed();
    expect(textOf(await client.callTool({ name: "get_pending", arguments: {} })).split("\n")[0]).toBe("count: 1");
  });

  async function httpClient(): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
    const http = new Client({ name: "test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${t.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${t.daemon.token}` } },
    });
    await http.connect(transport);
    return { client: http, transport };
  }

  it("keeps the watch cursor per MCP session between calls", async () => {
    const first = await httpClient();
    const second = await httpClient();
    client = first.client;
    try {
      expect(first.transport.sessionId).toBeTruthy();
      expect(first.transport.sessionId).not.toBe(second.transport.sessionId);
      await seed();
      expect(textOf(await first.client.callTool({ name: "watch_annotations", arguments: { timeoutSeconds: 2 } }))).toMatch(/^new: 1/);
      // Created between two calls of the first client.
      await seed();
      const started = Date.now();
      expect(textOf(await first.client.callTool({ name: "watch_annotations", arguments: { timeoutSeconds: 5 } }))).toMatch(/^new: 1/);
      expect(Date.now() - started).toBeLessThan(1500);
      // The second client has its own cursor: both annotations are still new to it.
      expect(textOf(await second.client.callTool({ name: "watch_annotations", arguments: { timeoutSeconds: 2 } }))).toMatch(/^new: 2/);
    } finally {
      await second.client.close();
    }
  });

  it("closes the session on DELETE and answers 404 for it afterwards", async () => {
    const { client: http, transport } = await httpClient();
    const sessionId = transport.sessionId!;
    await transport.terminateSession();
    await http.close();
    const response = await t.call("/mcp", {
      method: "POST",
      headers: { "mcp-session-id": sessionId, accept: "application/json, text/event-stream" },
      json: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(response.status).toBe(404);
  });

  it("requires initialize to open a session", async () => {
    const response = await t.call("/mcp", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream" },
      json: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(response.status).toBe(400);
  });

  it("refuses /mcp without the token", async () => {
    const response = await fetch(`${t.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(401);
  });
});
