import type { Annotation, AnnotationInput, AnnotationPatch, LiveClient, ServerEvent, Session } from "@ui-annotate/protocol";
import type { OriginSettings } from "./settings";

/** Requests from the overlay and the popup to the background, the only place that talks to the server. */
export type BackgroundRequest =
  | { type: "session.open"; url: string; title: string }
  | { type: "annotation.create"; sessionId: string; input: AnnotationInput }
  | { type: "annotation.patch"; id: string; patch: AnnotationPatch }
  | { type: "annotation.delete"; id: string }
  | { type: "annotation.comment"; id: string; body: string }
  | { type: "origin.get"; origin: string }
  | { type: "origin.set"; origin: string; settings: Partial<OriginSettings> }
  /** Live Claude Code sessions of the project of a page session, for Live session mode. */
  | { type: "clients.list"; sessionId: string }
  | { type: "status" }
  /** Inject the overlay and start annotating (tests, scripted use). */
  | { type: "tab.activate"; tabId: number }
  /** Inject the overlay and show it without changing the mode (opening the popup). */
  | { type: "tab.show"; tabId: number }
  /** Configured keys of the extension commands, for the popup and toolbar tooltips. */
  | { type: "shortcuts.get" }
  /** From the overlay: inject the MAIN-world resolver into the sender's tab again. */
  | { type: "resolver.ensure" };

/** Overlay actions bound to the extension commands of the manifest. */
export type OverlayAction = "overlay" | "annotate" | "markers" | "resolved";

/** Manifest command name → overlay action. */
export const COMMAND_ACTIONS: Record<string, OverlayAction> = {
  "toggle-overlay": "overlay",
  "toggle-annotate": "annotate",
  "toggle-markers": "markers",
  "toggle-resolved": "resolved",
};

/** Action → its current key, or null when unassigned. */
export type Shortcuts = Record<OverlayAction, string | null>;

export interface SessionState {
  session: Session;
  annotations: Annotation[];
  origin: OriginSettings;
}

export interface ServerStatus {
  serverUrl: string;
  /**
   * Host permission for the server origin. Firefox MV3 treats host_permissions as opt-in: an
   * install can be enabled without them, and every request to the daemon then fails.
   */
  hostAccess: boolean;
  reachable: boolean;
  /** The running daemon predates the extension's API (no automatic pairing). */
  outdated: boolean;
  tokenSet: boolean;
  tokenValid: boolean;
  version: string | null;
}

export type ResponseMap = {
  "session.open": SessionState;
  "annotation.create": Annotation;
  "annotation.patch": Annotation;
  "annotation.delete": { ok: true };
  "annotation.comment": Annotation;
  "origin.get": OriginSettings;
  "origin.set": OriginSettings;
  "clients.list": LiveClient[];
  status: ServerStatus;
  "tab.activate": { ok: true };
  "tab.show": { ok: true };
  "shortcuts.get": Shortcuts;
  "resolver.ensure": { ok: true };
};

export type BackgroundResponse<K extends BackgroundRequest["type"]> =
  | { ok: true; data: ResponseMap[K] }
  | { ok: false; error: string; status?: number };

/**
 * Messages from the background or the popup to the overlay of a tab.
 * - overlay.activate: show and start annotating;
 * - overlay.show: show, mode unchanged;
 * - overlay.command: one of the shortcut actions.
 */
export type OverlayMessage =
  | { type: "overlay.activate" }
  | { type: "overlay.show" }
  | { type: "overlay.command"; action: OverlayAction }
  | { type: "overlay.state" };

/** Answer to overlay.state; null while the overlay is injected but not mounted. */
export interface OverlaySnapshot {
  /** Overlay hidden entirely (toolbar, markers, cards) by the overlay command. */
  hidden: boolean;
  annotating: boolean;
  connection: "connecting" | "online" | "offline";
  error: string | null;
  open: number;
  total: number;
  /** Page session of the daemon, once the overlay has opened it. */
  sessionId: string | null;
  /** Project root of the page's session and where it came from (popup, agent, dev server, path). */
  projectRoot: string | null;
  projectRootSource: "manual" | "agent" | "port" | "path" | null;
}

export const EVENTS_PORT = "ui-annotate:events";

/** Port traffic: overlay subscribes to a session, background forwards server events. */
export type PortToBackground = { type: "subscribe"; sessionId: string } | { type: "ping" };
export type PortToOverlay = { type: "event"; event: ServerEvent } | { type: "stream"; state: "open" | "error" };
