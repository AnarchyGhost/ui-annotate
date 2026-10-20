import { readEventStream } from "./client.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { annotationInput, startTestDaemon, type TestDaemon } from "./test-helpers.js";

let t: TestDaemon;
beforeEach(async () => {
  t = await startTestDaemon();
});
afterEach(() => t.close());

async function createSession() {
  const response = await t.call("/sessions", { method: "POST", json: { url: "http://localhost:5173/settings", title: "Settings" } });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string };
}

describe("access control over HTTP", () => {
  it("answers /health without a token", async () => {
    const response = await fetch(`${t.url}/health`);
    expect(await response.json()).toMatchObject({ ok: true, name: "ui-annotate" });
  });

  it("returns 401 without a token", async () => {
    const response = await fetch(`${t.url}/sessions`);
    expect(response.status).toBe(401);
  });

  it("returns 403 for a web page origin even with the token", async () => {
    const response = await t.call("/sessions", { headers: { origin: "http://localhost:5173" } });
    expect(response.status).toBe(403);
  });

  it("returns 403 for a foreign Host header", async () => {
    // fetch() forbids overriding Host; go through node:http directly.
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: t.config.port, path: "/sessions", headers: { host: `evil.example:${t.config.port}`, authorization: `Bearer ${t.daemon.token}` } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("accepts a Firefox extension origin", async () => {
    const response = await t.call("/sessions", { headers: { origin: "moz-extension://1234-abcd" } });
    expect(response.status).toBe(200);
  });
});

describe("automatic pairing (POST /pair)", () => {
  const pair = (origin?: string) =>
    fetch(`${t.url}/pair`, { method: "POST", headers: origin ? { origin } : {} }).then(async (response) => ({
      status: response.status,
      body: (await response.json()) as { token?: string; error?: string },
    }));

  it("hands the token to the Chrome extension", async () => {
    expect(await pair("chrome-extension://pimhfahcdpnkbmflgggigkfdjolgemom")).toEqual({ status: 200, body: { token: t.daemon.token } });
  });

  it("refuses pages, other extensions and requests without Origin", async () => {
    for (const origin of ["http://localhost:5173", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "null", undefined]) {
      const result = await pair(origin);
      expect(result.status, String(origin)).toBe(403);
      expect(result.body.token).toBeUndefined();
    }
  });

  it("pins the first Firefox install and refuses others until unpair", async () => {
    const first = "moz-extension://5b0c7c0e-1111-4000-8000-000000000001";
    const second = "moz-extension://5b0c7c0e-2222-4000-8000-000000000002";
    expect((await pair(first)).status).toBe(200);
    expect((await pair(first)).status).toBe(200);
    expect((await pair(second)).status).toBe(403);
    const { writePairing } = await import("./pairing.js");
    writePairing(t.config.pairingPath, { firefox: null });
    expect((await pair(second)).body.token).toBe(t.daemon.token);
    expect((await pair(first)).status).toBe(403);
  });

  it("keeps the Host check", async () => {
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: t.config.port,
          path: "/pair",
          method: "POST",
          headers: { host: `evil.example:${t.config.port}`, origin: "chrome-extension://pimhfahcdpnkbmflgggigkfdjolgemom" },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});

describe("project root of a page", () => {
  it("is taken from absolute source paths of the first annotation and kept", async () => {
    // This repository is a real project on disk: packages/server/src lifts to its top level.
    const here = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
    const session = (await (await t.call("/sessions", { method: "POST", json: { url: "http://example.test:1/page", title: "" } })).json()) as {
      id: string;
      projectRoot: string | null;
    };
    expect(session.projectRoot).toBeNull();
    const input = annotationInput();
    input.targets[0]!.source = { ...input.targets[0]!.source, file: `${here}/packages/server/src/http.ts` };
    await t.call(`/sessions/${session.id}/annotations`, { method: "POST", json: input });
    const after = (await (await t.call(`/sessions/${session.id}`)).json()) as { projectRoot: string; projectRootSource: string };
    expect(after).toMatchObject({ projectRoot: here, projectRootSource: "path" });
  });

  it("follows link_page over detection and the popup setting over link_page", async () => {
    const url = "http://example.test:2/";
    const linked = (await (await t.call("/sessions/link", { method: "POST", json: { url, projectRoot: "/work/linked" } })).json()) as {
      id: string;
      projectRootSource: string;
    };
    expect(linked.projectRootSource).toBe("agent");
    const manual = (await (await t.call("/sessions", { method: "POST", json: { url, title: "", projectRoot: "/work/manual" } })).json()) as {
      projectRoot: string;
      projectRootSource: string;
    };
    expect(manual).toMatchObject({ projectRoot: "/work/manual", projectRootSource: "manual" });
    const relinked = (await (await t.call("/sessions/link", { method: "POST", json: { url, projectRoot: "/work/again" } })).json()) as { projectRoot: string };
    expect(relinked.projectRoot).toBe("/work/manual");
  });

  it("rejects a relative link", async () => {
    const response = await t.call("/sessions/link", { method: "POST", json: { url: "http://example.test:3/", projectRoot: "relative" } });
    expect(response.status).toBe(400);
  });
});

describe("annotation API", () => {
  it("creates, lists, patches, threads and deletes", async () => {
    const session = await createSession();
    const created = await t.call(`/sessions/${session.id}/annotations`, { method: "POST", json: annotationInput() });
    expect(created.status).toBe(200);
    const annotation = (await created.json()) as { id: string; number: number; status: string };
    expect(annotation).toMatchObject({ number: 1, status: "pending" });

    const listed = await (await t.call(`/sessions/${session.id}/annotations`)).json();
    expect(listed).toHaveLength(1);

    const patched = await (await t.call(`/annotations/${annotation.id}`, { method: "PATCH", json: { intent: "question" } })).json();
    expect(patched).toMatchObject({ intent: "question" });

    const threaded = (await (await t.call(`/annotations/${annotation.id}/thread`, { method: "POST", json: { body: "More context" } })).json()) as {
      thread: unknown[];
    };
    expect(threaded.thread).toEqual([expect.objectContaining({ role: "user", kind: "comment", body: "More context" })]);

    expect((await t.call(`/annotations/${annotation.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await t.call(`/annotations/${annotation.id}`)).status).toBe(404);
  });

  it("rejects invalid bodies and conflicting transitions", async () => {
    const session = await createSession();
    const bad = await t.call(`/sessions/${session.id}/annotations`, { method: "POST", json: { kind: "element" } });
    expect(bad.status).toBe(400);
    const { id } = (await (await t.call(`/sessions/${session.id}/annotations`, { method: "POST", json: annotationInput() })).json()) as { id: string };
    expect((await t.call(`/annotations/${id}/actions`, { method: "POST", json: { action: "resolve", summary: "done" } })).status).toBe(200);
    expect((await t.call(`/annotations/${id}/actions`, { method: "POST", json: { action: "resolve", summary: "again" } })).status).toBe(409);
  });

  it("finds the session of a page by URL", async () => {
    const session = await createSession();
    const found = (await (await t.call(`/sessions?url=${encodeURIComponent("http://localhost:5173/settings?x=1")}`)).json()) as { id: string };
    expect(found.id).toBe(session.id);
    expect((await t.call(`/sessions?url=${encodeURIComponent("http://localhost:5173/nope")}`)).status).toBe(404);
  });

  it("streams session events over SSE", async () => {
    const session = await createSession();
    const controller = new AbortController();
    const stream = await t.call(`/sessions/${session.id}/events`, { signal: controller.signal });
    const received = new Promise<string>((resolve) => {
      void readEventStream(stream.body!, (data) => resolve(JSON.parse(data).type)).catch(() => {});
    });
    await t.call(`/sessions/${session.id}/annotations`, { method: "POST", json: annotationInput() });
    expect(await received).toBe("annotation.created");
    controller.abort();
  });

  it("long-polls /watch and times out", async () => {
    const started = Date.now();
    const result = await (await t.call("/watch?timeout=1")).json();
    expect(result).toEqual({ timeout: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });
});
