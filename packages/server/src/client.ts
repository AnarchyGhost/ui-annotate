import { ServerEvent, appendNormalized, type Annotation, type Session, type SessionSummary } from "@ui-annotate/protocol";
import type { AnnotationApi } from "./api.js";

export class DaemonError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

const REQUEST_TIMEOUT_MS = 5000;

/** HTTP client of the daemon; implements the MCP tool operations for the stdio proxy. */
export class HttpApi implements AnnotationApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /** A wedged daemon must not stall hooks or tool calls: every request has a deadline. */
  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new DaemonError(response.status, payload.error ?? `HTTP ${response.status}`);
    return payload as T;
  }

  listSessions() {
    return this.request<SessionSummary[]>("GET", "/sessions");
  }

  getSession(id: string) {
    return this.request<Session>("GET", `/sessions/${encodeURIComponent(id)}`);
  }

  open(sessionId?: string) {
    const query = new URLSearchParams({ status: "open" });
    if (sessionId) query.set("sessionId", sessionId);
    return this.request<Annotation[]>("GET", `/annotations?${query}`);
  }

  get(id: string) {
    return this.request<Annotation>("GET", `/annotations/${encodeURIComponent(id)}`);
  }

  linkPage(url: string, projectRoot: string) {
    return this.request<Session>("POST", "/sessions/link", { url, projectRoot });
  }

  private action(id: string, body: Record<string, string>) {
    return this.request<Annotation>("POST", `/annotations/${encodeURIComponent(id)}/actions`, body);
  }

  acknowledge(id: string) {
    return this.action(id, { action: "acknowledge" });
  }

  reply(id: string, message: string) {
    return this.action(id, { action: "reply", message });
  }

  resolve(id: string, summary: string) {
    return this.action(id, { action: "resolve", summary });
  }

  dismiss(id: string, reason: string) {
    return this.action(id, { action: "dismiss", reason });
  }

  async watch(sessionId: string | undefined, timeoutSeconds: number, since: string | null = null, signal?: AbortSignal) {
    const query = new URLSearchParams({ timeout: String(timeoutSeconds) });
    if (sessionId) query.set("sessionId", sessionId);
    if (since) query.set("since", since);
    const result = await this.request<{ timeout: boolean; annotations?: Annotation[] }>(
      "GET",
      `/watch?${query}`,
      undefined,
      signal,
      timeoutSeconds * 1000 + REQUEST_TIMEOUT_MS,
    );
    return result.timeout ? null : (result.annotations ?? []);
  }

  /** Follows GET /events and reconnects with backoff until unsubscribed. */
  subscribe(listener: (event: ServerEvent) => void): () => void {
    const controller = new AbortController();
    const loop = async () => {
      let delay = 500;
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(`${this.baseUrl}/events`, {
            headers: { authorization: `Bearer ${this.token}`, accept: "text/event-stream" },
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new DaemonError(response.status, "event stream refused");
          delay = 500;
          await readEventStream(response.body, (data) => {
            const parsed = ServerEvent.safeParse(JSON.parse(data));
            if (parsed.success) listener(parsed.data);
          });
        } catch {
          if (controller.signal.aborted) return;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 10_000);
      }
    };
    void loop();
    return () => controller.abort();
  }
}

/** Minimal text/event-stream reader: calls `onData` with each event's joined data lines. */
export async function readEventStream(body: ReadableStream<Uint8Array>, onData: (data: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer = appendNormalized(buffer, decoder.decode(chunk, { stream: true }));
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        try {
          onData(data);
        } catch {
          // A malformed event must not end the stream.
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}
