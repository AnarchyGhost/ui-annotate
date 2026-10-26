import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Annotation, LiveClient } from "@ui-annotate/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { annotationInput, startTestDaemon, type TestDaemon } from "./test-helpers.js";

const ROOT = "/work/app";
let t: TestDaemon;
const streams: AbortController[] = [];

beforeEach(async () => {
  t = await startTestDaemon({}, { ackTimeoutMs: 300 });
});

afterEach(async () => {
  for (const stream of streams.splice(0)) stream.abort();
  await t.close();
});

async function session(projectRoot: string | null = ROOT, url = "http://localhost:5173/settings") {
  const response = await t.call("/sessions", { method: "POST", json: { url, title: "Settings", projectRoot } });
  return ((await response.json()) as { id: string }).id;
}

const clients = async (sessionId: string) => (await (await t.call(`/sessions/${sessionId}/clients`)).json()) as LiveClient[];
const fetchAnnotation = async (id: string) => (await (await t.call(`/annotations/${id}`)).json()) as Annotation;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Opens a channel stream as the stdio MCP server does and waits until the daemon lists it. */
async function connect(pid: number, cwd = ROOT): Promise<AbortController> {
  const controller = new AbortController();
  streams.push(controller);
  const query = new URLSearchParams({ clientPid: String(pid), cwd, entrypoint: "cli" });
  const response = await fetch(`${t.url}/events?${query}`, { headers: { authorization: `Bearer ${t.daemon.token}` }, signal: controller.signal });
  expect(response.status).toBe(200);
  void response.body?.pipeTo(new WritableStream()).catch(() => undefined);
  const probe = await session();
  while (cwd.startsWith(ROOT) && !(await clients(probe)).some((client) => client.pid === pid)) await sleep(10);
  return controller;
}

async function annotateLive(sessionId: string, clientPid: number | null) {
  const response = await t.call(`/sessions/${sessionId}/annotations`, {
    method: "POST",
    json: annotationInput({ delivery: { mode: "session", clientPid } }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Annotation;
}

describe("live clients", () => {
  it("lists the channel sessions of the project with name and state from the session file", async () => {
    mkdirSync(join(t.dir, "claude-sessions"), { recursive: true });
    writeFileSync(join(t.dir, "claude-sessions", "101.json"), JSON.stringify({ name: "front", status: "busy", sessionId: "x" }));
    await connect(101);
    await connect(102, `${ROOT}/packages/web`);
    await connect(103, "/work/other");
    const listed = await clients(await session());
    expect(listed.map((client) => [client.pid, client.name, client.status, client.entrypoint])).toEqual([
      [101, "front", "busy", "cli"],
      [102, null, null, "cli"],
    ]);
    expect(await clients(await session(null, "http://localhost:5174/"))).toEqual([]);
  });

  it("drops a session when its stream closes", async () => {
    const stream = await connect(101);
    const sessionId = await session();
    stream.abort();
    while ((await clients(sessionId)).length > 0) await sleep(10);
  });

  it("needs the token", async () => {
    const sessionId = await session();
    const response = await fetch(`${t.url}/sessions/${sessionId}/clients`);
    expect(response.status).toBe(401);
  });
});

describe("Live session delivery", () => {
  it("stores the live target and warns once when the session does not react", async () => {
    await connect(101);
    const created = await annotateLive(await session(), 101);
    expect(created.delivery).toEqual({ mode: "session", clientPid: 101 });
    expect(created.thread).toEqual([]);
    await sleep(500);
    const annotation = await fetchAnnotation(created.id);
    expect(annotation.thread).toHaveLength(1);
    expect(annotation.thread[0]?.body).toMatch(/^Live session: no reaction.*--dangerously-load-development-channels/);
  });

  it("stays quiet when the session acknowledges in time", async () => {
    await connect(101);
    const created = await annotateLive(await session(), 101);
    await t.call(`/annotations/${created.id}/actions`, { method: "POST", json: { action: "acknowledge" } });
    await sleep(500);
    expect((await fetchAnnotation(created.id)).thread.map((message) => message.kind)).toEqual(["acknowledge"]);
  });

  it("moves to the only live session after a restart", async () => {
    await connect(202);
    const created = await annotateLive(await session(), 101);
    expect(created.delivery).toEqual({ mode: "session", clientPid: 202 });
  });

  it("waits with a note when the chosen session is not running", async () => {
    await connect(202);
    await connect(203);
    const created = await annotateLive(await session(), 101);
    expect(created.delivery).toEqual({ mode: "session", clientPid: 101 });
    expect(created.status).toBe("pending");
    expect(created.thread[0]?.body).toMatch(/^Live session: the chosen Claude Code session is not running/);
  });

  it("hands waiting annotations to a session that connects later", async () => {
    const sessionId = await session();
    const waiting = await annotateLive(sessionId, 101);
    await connect(202);
    expect((await fetchAnnotation(waiting.id)).delivery).toEqual({ mode: "session", clientPid: 202 });
  });

  it("hands them to the remaining session when the chosen one quits", async () => {
    await connect(202);
    const chosen = await connect(203);
    const sessionId = await session();
    const created = await annotateLive(sessionId, 203);
    chosen.abort();
    while ((await clients(sessionId)).length > 1) await sleep(10);
    expect((await fetchAnnotation(created.id)).delivery).toEqual({ mode: "session", clientPid: 202 });
  });
});
