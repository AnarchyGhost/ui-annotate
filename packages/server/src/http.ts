import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  AnnotationInput,
  AnnotationPatch,
  AnnotationStatus,
  SessionInput,
  ThreadInput,
  type ServerEvent,
} from "@ui-annotate/protocol";
import { z } from "zod";
import { LocalApi, OPEN_STATUSES, clampWatchTimeout, waitForCreated } from "./api.js";
import type { Dispatcher } from "./dispatch.js";
import { TransitionError, deliveryOf } from "./domain.js";
import type { LiveClients } from "./live-clients.js";
import { createMcpServer } from "./mcp.js";
import { decidePairing, readPairing, writePairing } from "./pairing.js";
import { rootFromPort, rootFromSources } from "./project-root.js";
import { checkAccess, type AccessPolicy } from "./security.js";
import { NotFoundError, type Store } from "./store.js";
import { API_LEVEL, VERSION } from "./version.js";

const MAX_BODY_BYTES = 1_000_000;
const SSE_KEEPALIVE_MS = 15_000;
const MCP_SESSION_IDLE_MS = 30 * 60_000;
const MCP_SWEEP_INTERVAL_MS = 60_000;

interface McpSession {
  server: ReturnType<typeof createMcpServer>;
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Body of POST /sessions/link: an agent ties a page to its project (link_page tool). */
const LinkInput = z.object({
  url: z.string().url().max(2000),
  projectRoot: z.string().min(1).max(1000).refine((value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value), "absolute path"),
});

const AgentAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("acknowledge") }),
  z.object({ action: z.literal("reply"), message: z.string().min(1) }),
  z.object({ action: z.literal("resolve"), summary: z.string().min(1) }),
  z.object({ action: z.literal("dismiss"), reason: z.string().min(1) }),
]);

interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
}

type Handler = (ctx: Context) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
  /** Responds itself (SSE, MCP); the router does not serialize the return value. */
  raw?: boolean;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

async function parseBody<T extends z.ZodType>(req: IncomingMessage, schema: T): Promise<z.infer<T>> {
  const result = schema.safeParse(await readBody(req));
  if (!result.success) throw new HttpError(400, z.prettifyError(result.error));
  return result.data;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function openEventStream(ctx: Context, store: Store, filter: (event: ServerEvent) => boolean): void {
  const { req, res } = ctx;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  const onEvent = (event: ServerEvent) => {
    if (filter(event)) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), SSE_KEEPALIVE_MS);
  store.on("event", onEvent);
  req.on("close", () => {
    clearInterval(keepalive);
    store.off("event", onEvent);
  });
}

function parseStatuses(value: string | null): AnnotationStatus[] | undefined {
  if (!value) return undefined;
  if (value === "open") return [...OPEN_STATUSES];
  return value.split(",").map((status) => AnnotationStatus.parse(status.trim()));
}

export interface DaemonOptions {
  store: Store;
  policy: AccessPolicy;
  host: string;
  /** File with the pinned Firefox origin of POST /pair. */
  pairingPath: string;
  /** Background agent runs for annotations of sites in Background agent mode; absent: the field is ignored. */
  dispatcher?: Dispatcher;
  /** Claude Code sessions with a connected channel, for Live session mode. */
  live: LiveClients;
}

/** Identity of a channel stream: `GET /events?clientPid=<claude pid>&cwd=<dir>&entrypoint=<cli>`. */
const ClientQuery = z.object({
  clientPid: z.coerce.number().int().positive(),
  cwd: z.string().min(1),
  entrypoint: z.string().nullable(),
});

export function createDaemon({ store, policy, host, pairingPath, dispatcher, live }: DaemonOptions): Server {
  const api = new LocalApi(store);
  const routes: Route[] = [];
  const mcpSessions = new Map<string, McpSession>();
  // Clients that vanish without DELETE leave sessions behind; idle ones are closed.
  const sweep = setInterval(() => {
    const deadline = Date.now() - MCP_SESSION_IDLE_MS;
    for (const [id, session] of mcpSessions) {
      if (session.lastSeen >= deadline) continue;
      mcpSessions.delete(id);
      void session.transport.close();
      void session.server.close();
    }
  }, MCP_SWEEP_INTERVAL_MS);
  sweep.unref();
  const route = (method: string, path: string, handler: Handler, raw = false) => {
    const pattern = new RegExp(`^${path.replace(/:\w+/g, "([^/]+)")}$`);
    routes.push({ method, pattern, handler, raw });
  };

  route("GET", "/sessions", ({ url }) => {
    const pageUrl = url.searchParams.get("url");
    if (!pageUrl) return store.listSessions();
    const session = store.findSessionByUrl(pageUrl, url.searchParams.get("includeHash") === "true");
    if (!session) throw new HttpError(404, "session not found");
    return session;
  });
  route("POST", "/sessions", async ({ req }) => {
    const input = await parseBody(req, SessionInput);
    const session = store.upsertSession(input);
    if (session.projectRoot) return session;
    // No root yet: the dev server behind a localhost page tells it through its working directory.
    const root = await rootFromPort(input.url).catch(() => null);
    return root ? store.setProjectRoot(session.id, root, "port") : session;
  });
  route("POST", "/sessions/link", async ({ req }) => {
    const { url, projectRoot } = await parseBody(req, LinkInput);
    const session = store.upsertSession({ url, title: "", includeHash: false, projectRoot: null });
    return store.setProjectRoot(session.id, projectRoot, "agent");
  });
  route("GET", "/sessions/:id", ({ params }) => store.getSession(params[0]!));
  route("GET", "/sessions/:id/clients", ({ params }) => live.forRoot(store.getSession(params[0]!).projectRoot));
  route("GET", "/sessions/:id/annotations", ({ params, url }) =>
    store.listAnnotations({ sessionId: params[0]!, statuses: parseStatuses(url.searchParams.get("status")) }),
  );
  route(
    "GET",
    "/sessions/:id/events",
    (ctx) => {
      const sessionId = store.getSession(ctx.params[0]!).id;
      openEventStream(ctx, store, (event) =>
        event.type === "annotation.deleted" ? event.sessionId === sessionId : event.annotation.sessionId === sessionId,
      );
    },
    true,
  );
  route("POST", "/sessions/:id/annotations", async ({ req, params }) => {
    const input = await parseBody(req, AnnotationInput);
    const session = store.getSession(params[0]!);
    // Set before the annotation exists, so hooks and the channel already scope it to the project.
    let scoped = session;
    if (!session.projectRoot) {
      const root = rootFromSources(input.targets.map((target) => target.source));
      if (root) scoped = store.setProjectRoot(session.id, root, "path");
    }
    const delivery = live.prepare(scoped, deliveryOf(input));
    const annotation = store.createAnnotation(session.id, input, delivery);
    if (delivery.mode === "background") dispatcher?.enqueue(annotation, delivery);
    live.afterCreate(annotation);
    return store.getAnnotation(annotation.id);
  });

  route("GET", "/annotations", ({ url }) =>
    store.listAnnotations({
      sessionId: url.searchParams.get("sessionId") ?? undefined,
      statuses: parseStatuses(url.searchParams.get("status")),
    }),
  );
  route("GET", "/annotations/:id", ({ params }) => store.getAnnotation(params[0]!));
  route("PATCH", "/annotations/:id", async ({ req, params }) => store.patchAnnotation(params[0]!, await parseBody(req, AnnotationPatch)));
  route("DELETE", "/annotations/:id", ({ params }) => {
    store.deleteAnnotation(params[0]!);
    return { ok: true };
  });
  route("POST", "/annotations/:id/thread", async ({ req, params }) => {
    const { body } = await parseBody(req, ThreadInput);
    return store.addMessage(params[0]!, "user", "comment", body);
  });
  route("POST", "/annotations/:id/actions", async ({ req, params }) => {
    const action = await parseBody(req, AgentAction);
    const id = params[0]!;
    switch (action.action) {
      case "acknowledge":
        return api.acknowledge(id);
      case "reply":
        return api.reply(id, action.message);
      case "resolve":
        return api.resolve(id, action.summary);
      case "dismiss":
        return api.dismiss(id, action.reason);
    }
  });

  route(
    "GET",
    "/events",
    (ctx) => {
      const sessionId = ctx.url.searchParams.get("sessionId");
      if (ctx.url.searchParams.has("clientPid")) {
        const identity = ClientQuery.parse({
          clientPid: ctx.url.searchParams.get("clientPid"),
          cwd: ctx.url.searchParams.get("cwd"),
          entrypoint: ctx.url.searchParams.get("entrypoint"),
        });
        const release = live.connect({ pid: identity.clientPid, cwd: identity.cwd, entrypoint: identity.entrypoint });
        if (release) ctx.req.on("close", release);
      }
      openEventStream(ctx, store, (event) => {
        if (!sessionId) return true;
        return event.type === "annotation.deleted" ? event.sessionId === sessionId : event.annotation.sessionId === sessionId;
      });
    },
    true,
  );
  route("GET", "/watch", async ({ url, req }) => {
    const controller = new AbortController();
    req.on("close", () => controller.abort());
    const timeout = clampWatchTimeout(Number(url.searchParams.get("timeout") ?? "25"));
    const since = url.searchParams.get("since");
    const batch = await waitForCreated(store, url.searchParams.get("sessionId") ?? undefined, timeout, controller.signal, since);
    return batch ? { timeout: false, annotations: batch } : { timeout: true };
  });

  route(
    "*",
    "/mcp",
    async ({ req, res }) => {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const header = req.headers["mcp-session-id"];
      const sessionId = typeof header === "string" ? header : undefined;
      let session = sessionId ? mcpSessions.get(sessionId) : undefined;
      if (!session) {
        // MCP spec: an unknown session id is 404, the client re-initializes; a new session starts only with initialize.
        if (sessionId) throw new HttpError(404, "unknown MCP session; initialize again");
        if (!isInitializeRequest(body)) throw new HttpError(400, "no MCP session; send initialize first");
        session = await openMcpSession();
      }
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res, body);
    },
    true,
  );

  /**
   * Stateful Streamable HTTP: one MCP server per Mcp-Session-Id, so per-session state such as the
   * watch_annotations cursor survives between calls, as it does for a stdio process.
   */
  async function openMcpSession(): Promise<McpSession> {
    const server = createMcpServer(api, { cwd: null, channel: false });
    const session: McpSession = {
      server,
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => void mcpSessions.set(id, session),
        onsessionclosed: (id) => void mcpSessions.delete(id),
      }),
      lastSeen: Date.now(),
    };
    session.transport.onclose = () => {
      if (session.transport.sessionId) mcpSessions.delete(session.transport.sessionId);
    };
    await server.connect(session.transport);
    return session;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    try {
      if (url.pathname === "/health" && req.method === "GET") {
        const rejected = checkAccess(req.headers, policy, false);
        if (rejected) return sendJson(res, rejected.status, { error: rejected.error });
        return sendJson(res, 200, { ok: true, name: "ui-annotate", version: VERSION, api: API_LEVEL, pid: process.pid });
      }
      if (url.pathname === "/pair" && req.method === "POST") {
        const rejected = checkAccess(req.headers, policy, false);
        if (rejected) return sendJson(res, rejected.status, { error: rejected.error });
        const decision = decidePairing(req.headers.origin, readPairing(pairingPath).firefox);
        if (!decision.ok) return sendJson(res, 403, { error: decision.error });
        if (decision.pinFirefox) writePairing(pairingPath, { firefox: decision.pinFirefox });
        return sendJson(res, 200, { token: policy.token });
      }
      const rejected = checkAccess(req.headers, policy, true);
      if (rejected) return sendJson(res, rejected.status, { error: rejected.error });

      for (const candidate of routes) {
        if (candidate.method !== "*" && candidate.method !== req.method) continue;
        const match = url.pathname.match(candidate.pattern);
        if (!match) continue;
        const params = match.slice(1).map(decodeURIComponent);
        const result = await candidate.handler({ req, res, url, params });
        if (!candidate.raw) sendJson(res, 200, result);
        return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
      if (error instanceof NotFoundError) return sendJson(res, 404, { error: error.message });
      if (error instanceof TransitionError) return sendJson(res, 409, { error: error.message });
      if (error instanceof z.ZodError) return sendJson(res, 400, { error: z.prettifyError(error) });
      console.error("[ui-annotate] request failed:", error);
      sendJson(res, 500, { error: "internal error" });
    }
  });
  // Long-poll and SSE connections outlive the default request timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.on("close", () => {
    clearInterval(sweep);
    for (const session of mcpSessions.values()) {
      void session.transport.close();
      void session.server.close();
    }
    mcpSessions.clear();
  });
  return server;
}
