import { ServerEvent, appendNormalized } from "@ui-annotate/protocol";

export class ServerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ServerError";
  }
}

/** Background-side client of the local daemon. Requests carry the token; no CORS is involved. */
export class ServerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ServerError(0, `ui-annotate server is not reachable at ${this.baseUrl}. Run: npx ui-annotate serve`);
    }
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new ServerError(response.status, payload.error ?? `HTTP ${response.status}`);
    return payload as T;
  }

  /** Asks the daemon for its token; it answers only the ui-annotate extension origin. */
  async pair(): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/pair`, { method: "POST" });
    } catch {
      throw new ServerError(0, `ui-annotate server is not reachable at ${this.baseUrl}. Run: npx ui-annotate serve`);
    }
    const payload = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
    // A daemon from before automatic pairing has no /pair and answers it with 401.
    if (response.status === 401) {
      throw new ServerError(401, "ui-annotate server is older than the extension: stop it and run `npx ui-annotate serve` (or start a Claude Code session, the plugin restarts it)");
    }
    if (!response.ok || !payload.token) throw new ServerError(response.status, payload.error ?? "pairing refused");
    return payload.token;
  }

  async health(): Promise<{ ok: boolean; version: string; api?: number } | null> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok ? ((await response.json()) as { ok: boolean; version: string; api?: number }) : null;
    } catch {
      return null;
    }
  }

  /** Reads the session SSE stream until `signal` aborts or the stream ends. */
  async streamSession(sessionId: string, signal: AbortSignal, onEvent: (event: ServerEvent) => void, onOpen: () => void) {
    const response = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events`, {
      headers: { authorization: `Bearer ${this.token}`, accept: "text/event-stream" },
      signal,
    });
    if (!response.ok || !response.body) throw new ServerError(response.status, "event stream refused");
    onOpen();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer = appendNormalized(buffer, decoder.decode(value, { stream: true }));
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
          const parsed = ServerEvent.safeParse(safeJson(data));
          if (parsed.success) onEvent(parsed.data);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
