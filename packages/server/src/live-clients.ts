import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LIMITS, type Annotation, type Delivery, type LiveClient, type Session } from "@ui-annotate/protocol";
import { z } from "zod";
import { OPEN_STATUSES } from "./api.js";
import { resolveLiveTarget, withinRoot } from "./domain.js";
import type { Store } from "./store.js";

/** How long a Live session has to react before the thread says the push may not have arrived. */
const ACK_TIMEOUT_MS = 60_000;

/**
 * `~/.claude/sessions/<pid>.json` of Claude Code. Not documented, so every field is optional and
 * a changed format only costs the name and state in the popup.
 */
const SessionFile = z.object({
  name: z.string().nullish(),
  status: z.string().nullish(),
});

export interface ClientIdentity {
  pid: number;
  cwd: string;
  entrypoint: string | null;
}

export interface LiveClientsOptions {
  /** Directory of Claude Code's session files. */
  sessionsDir?: string;
  ackTimeoutMs?: number;
}

interface Entry {
  client: Omit<LiveClient, "name" | "status">;
  /** Open event streams of this PID: a reconnecting channel overlaps its old stream briefly. */
  streams: number;
}

/**
 * Claude Code sessions with a connected ui-annotate channel, and the delivery of Live session
 * annotations to them. A session is live while its event stream (`GET /events?clientPid=`) is
 * open; the stdio MCP server holds it for as long as `claude` runs.
 */
export class LiveClients {
  private readonly entries = new Map<number, Entry>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly sessionsDir: string;
  private readonly ackTimeoutMs: number;

  constructor(
    private readonly store: Store,
    options: LiveClientsOptions = {},
  ) {
    this.sessionsDir = options.sessionsDir ?? join(homedir(), ".claude", "sessions");
    const envSeconds = Number(process.env.UI_ANNOTATE_LIVE_ACK_SECONDS);
    this.ackTimeoutMs = options.ackTimeoutMs ?? (envSeconds > 0 ? envSeconds * 1000 : ACK_TIMEOUT_MS);
  }

  /** Registers a stream; returns its release, or null when the registry is full. */
  connect(identity: ClientIdentity): (() => void) | null {
    const existing = this.entries.get(identity.pid);
    if (!existing && this.entries.size >= LIMITS.liveClients) return null;
    const entry = existing ?? {
      client: {
        pid: identity.pid,
        cwd: identity.cwd.slice(0, LIMITS.filePath),
        entrypoint: identity.entrypoint?.slice(0, 32) ?? null,
        connectedAt: new Date().toISOString(),
      },
      streams: 0,
    };
    entry.streams += 1;
    this.entries.set(identity.pid, entry);
    if (!existing) this.adoptWaiting();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.streams -= 1;
      if (entry.streams > 0 || this.entries.get(identity.pid) !== entry) return;
      this.entries.delete(identity.pid);
      // Runs from the stream's close event, also while the daemon shuts down: never throw there.
      try {
        this.adoptWaiting();
      } catch (error) {
        console.error("[ui-annotate] live session hand-over failed:", error);
      }
    };
  }

  isLive(pid: number): boolean {
    return this.entries.has(pid);
  }

  /** Live sessions working inside the project root, oldest first; none without a root. */
  forRoot(root: string | null): LiveClient[] {
    if (!root) return [];
    return [...this.entries.values()]
      .filter((entry) => withinRoot(entry.client.cwd, root))
      .map((entry) => ({ ...entry.client, ...this.readSessionFile(entry.client.pid) }));
  }

  /** Delivery to store for a new annotation: a Live session target follows a restarted `claude`. */
  prepare(session: Session, delivery: Delivery): Delivery {
    if (delivery.mode !== "session") return delivery;
    const livePids = this.forRoot(session.projectRoot).map((client) => client.pid);
    return { mode: "session", clientPid: resolveLiveTarget(delivery.clientPid, livePids).clientPid };
  }

  /** Tells the thread when nobody can take the annotation, or later when nobody took it. */
  afterCreate(annotation: Annotation): void {
    const { delivery } = annotation;
    if (delivery.mode !== "session") return;
    if (delivery.clientPid === null || !this.isLive(delivery.clientPid)) {
      this.store.addMessage(annotation.id, "agent", "reply", "Live session: the chosen Claude Code session is not running; the annotation waits for it.");
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.checkAcknowledged(annotation.id);
    }, this.ackTimeoutMs);
    timer.unref();
    this.timers.add(timer);
  }

  close(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private checkAcknowledged(id: string): void {
    let current: Annotation;
    try {
      current = this.store.getAnnotation(id);
    } catch {
      return;
    }
    if (current.status !== "pending" || current.thread.some((message) => message.role === "agent")) return;
    this.store.addMessage(
      id,
      "agent",
      "reply",
      "Live session: no reaction from the Claude Code session yet. It may be busy with a long turn, or started without `--dangerously-load-development-channels`, which drops channel messages silently.",
    );
  }

  /**
   * When sessions come or go, open Live session annotations whose session is gone move by the same
   * rule as new ones: to the only live session of their project. Its hooks show them; the channel
   * pushes only new ones.
   */
  private adoptWaiting(): void {
    const sessions = new Map<string, Session>();
    for (const annotation of this.store.listAnnotations({ statuses: [...OPEN_STATUSES] })) {
      const { delivery } = annotation;
      if (delivery.mode !== "session" || (delivery.clientPid !== null && this.isLive(delivery.clientPid))) continue;
      const session = sessions.get(annotation.sessionId) ?? this.store.getSession(annotation.sessionId);
      sessions.set(session.id, session);
      const livePids = this.forRoot(session.projectRoot).map((client) => client.pid);
      const target = resolveLiveTarget(delivery.clientPid, livePids);
      if (target.rebound) this.store.setDelivery(annotation.id, { mode: "session", clientPid: target.clientPid });
    }
  }

  private readSessionFile(pid: number): Pick<LiveClient, "name" | "status"> {
    try {
      const parsed = SessionFile.safeParse(JSON.parse(readFileSync(join(this.sessionsDir, `${pid}.json`), "utf8")));
      if (!parsed.success) return { name: null, status: null };
      const { name, status } = parsed.data;
      return {
        name: name ? name.slice(0, LIMITS.title) : null,
        status: status === "idle" || status === "busy" ? status : null,
      };
    } catch {
      return { name: null, status: null };
    }
  }
}
