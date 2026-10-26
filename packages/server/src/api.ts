import { WATCH_TIMEOUT_MAX_SECONDS, type Annotation, type ServerEvent, type Session, type SessionSummary } from "@ui-annotate/protocol";
import type { ClientIdentity } from "./live-clients.js";
import type { Store } from "./store.js";

/** Open work for the agent: not yet resolved or dismissed. */
export const OPEN_STATUSES = ["pending", "acknowledged"] as const;

/** Operations behind the MCP tools; served by the daemon store or proxied over HTTP. */
export interface AnnotationApi {
  listSessions(): Promise<SessionSummary[]>;
  getSession(id: string): Promise<Session>;
  open(sessionId?: string): Promise<Annotation[]>;
  get(id: string): Promise<Annotation>;
  /** Ties the page at `url` to a project root on behalf of an agent (link_page). */
  linkPage(url: string, projectRoot: string): Promise<Session>;
  acknowledge(id: string): Promise<Annotation>;
  reply(id: string, message: string): Promise<Annotation>;
  resolve(id: string, summary: string): Promise<Annotation>;
  dismiss(id: string, reason: string): Promise<Annotation>;
  /**
   * Pending annotations created after `since` (ISO time); when there are none, the ones created
   * while waiting; null on timeout. `signal` ends the wait when the caller goes away.
   */
  watch(sessionId: string | undefined, timeoutSeconds: number, since?: string | null, signal?: AbortSignal): Promise<Annotation[] | null>;
  /** `client`: the identity a channel registers with (HTTP only; the in-process API ignores it). */
  subscribe(listener: (event: ServerEvent) => void, client?: ClientIdentity): () => void;
}

export const clampWatchTimeout = (seconds: number): number =>
  Math.min(Math.max(Number.isFinite(seconds) ? seconds : WATCH_TIMEOUT_MAX_SECONDS, 1), WATCH_TIMEOUT_MAX_SECONDS);

/** Annotations arriving within this window after the first one are returned in the same batch. */
const BATCH_WINDOW_MS = 400;

/**
 * Long-poll on store events. Resolves with the first batch of created annotations or null once
 * the timeout passes; `signal` aborts the wait (client gone).
 */
export function waitForCreated(
  store: Store,
  sessionId: string | undefined,
  timeoutSeconds: number,
  signal?: AbortSignal,
  since: string | null = null,
): Promise<Annotation[] | null> {
  if (since) {
    const due = store.listAnnotations({ sessionId, statuses: ["pending"] }).filter((annotation) => annotation.createdAt > since);
    if (due.length > 0) return Promise.resolve(due);
  }
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const batch: Annotation[] = [];
    let batchTimer: NodeJS.Timeout | null = null;
    const finish = (result: Annotation[] | null) => {
      clearTimeout(timeout);
      if (batchTimer) clearTimeout(batchTimer);
      store.off("event", onEvent);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onEvent = (event: ServerEvent) => {
      if (event.type !== "annotation.created") return;
      if (sessionId && event.annotation.sessionId !== sessionId) return;
      batch.push(event.annotation);
      batchTimer ??= setTimeout(() => finish(batch), BATCH_WINDOW_MS);
    };
    const onAbort = () => finish(null);
    const timeout = setTimeout(() => finish(batch.length ? batch : null), clampWatchTimeout(timeoutSeconds) * 1000);
    store.on("event", onEvent);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class LocalApi implements AnnotationApi {
  constructor(private readonly store: Store) {}

  async listSessions() {
    return this.store.listSessions();
  }

  async getSession(id: string) {
    return this.store.getSession(id);
  }

  async open(sessionId?: string) {
    return this.store.listAnnotations({ sessionId, statuses: [...OPEN_STATUSES] });
  }

  async get(id: string) {
    return this.store.getAnnotation(id);
  }

  async linkPage(url: string, projectRoot: string) {
    const session = this.store.upsertSession({ url, title: "", includeHash: false, projectRoot: null });
    return this.store.setProjectRoot(session.id, projectRoot, "agent");
  }

  async acknowledge(id: string) {
    return this.store.transition(id, { action: "acknowledge", role: "agent" });
  }

  async reply(id: string, message: string) {
    return this.store.addMessage(id, "agent", "reply", message);
  }

  async resolve(id: string, summary: string) {
    return this.store.transition(id, { action: "resolve", role: "agent", summary });
  }

  async dismiss(id: string, reason: string) {
    return this.store.transition(id, { action: "dismiss", role: "agent", reason });
  }

  watch(sessionId: string | undefined, timeoutSeconds: number, since: string | null = null, signal?: AbortSignal) {
    return waitForCreated(this.store, sessionId, timeoutSeconds, signal, since);
  }

  subscribe(listener: (event: ServerEvent) => void) {
    this.store.on("event", listener);
    return () => {
      this.store.off("event", listener);
    };
  }
}
