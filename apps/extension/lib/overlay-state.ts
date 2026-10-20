import { LIMITS, type Annotation, type AnnotationInput, type Intent, type Rect, type Session, type Severity, type Target } from "@ui-annotate/protocol";
import { reactive } from "vue";
import { browser } from "wxt/browser";
import { pingResolver, requestSource } from "./bridge";
import { buildDomContext, describeElement, documentRect } from "./dom-context";
import { EVENTS_PORT, type PortToBackground, type PortToOverlay } from "./messages";
import { send } from "./messaging";
import type { Pick } from "./picker";
import type { OriginSettings } from "./settings";

export interface Draft {
  pick: Pick;
  label: string;
  comment: string;
  intent: Intent;
  severity: Severity;
  saving: boolean;
  error: string | null;
}

export type Connection = "connecting" | "online" | "offline";

export interface OverlayState {
  session: Session | null;
  annotations: Annotation[];
  origin: OriginSettings | null;
  connection: Connection;
  error: string | null;
  annotating: boolean;
  markersHidden: boolean;
  draft: Draft | null;
  openCardId: string | null;
  hoverRect: Rect | null;
  multiRects: Rect[];
  areaRect: Rect | null;
  /** Bumped on scroll, resize and DOM mutations so markers recompute their placement. */
  layoutTick: number;
}

export function createState(): OverlayState {
  return reactive({
    session: null,
    annotations: [],
    origin: null,
    connection: "connecting",
    error: null,
    annotating: false,
    markersHidden: false,
    draft: null,
    openCardId: null,
    hoverRect: null,
    multiRects: [],
    areaRect: null,
    layoutTick: 0,
  }) as OverlayState;
}

export function upsertAnnotation(state: OverlayState, annotation: Annotation): void {
  if (state.session && annotation.sessionId !== state.session.id) return;
  const index = state.annotations.findIndex((item) => item.id === annotation.id);
  if (index === -1) state.annotations.push(annotation);
  else state.annotations[index] = annotation;
  state.annotations.sort((a, b) => a.number - b.number);
}

export function removeAnnotation(state: OverlayState, id: string): void {
  state.annotations = state.annotations.filter((item) => item.id !== id);
  if (state.openCardId === id) state.openCardId = null;
}

let openSequence = 0;

/** Navigation, reconnects and Retry overlap; only the latest request may write the state. */
export async function openSession(state: OverlayState): Promise<void> {
  const sequence = ++openSequence;
  const url = location.href;
  state.connection = "connecting";
  try {
    const result = await send({ type: "session.open", url, title: document.title });
    if (sequence !== openSequence || url !== location.href) return;
    state.session = result.session;
    state.annotations = result.annotations;
    state.origin = result.origin;
    state.connection = "online";
    state.error = null;
  } catch (error) {
    if (sequence !== openSequence) return;
    state.connection = "offline";
    state.error = error instanceof Error ? error.message : String(error);
  }
}

/** Follows server events of the session through the background; reconnects when the worker restarts. */
export function subscribe(state: OverlayState): () => void {
  let port: ReturnType<typeof browser.runtime.connect> | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const ping = setInterval(() => port?.postMessage({ type: "ping" } satisfies PortToBackground), 20_000);

  const connect = () => {
    if (stopped || !state.session) return;
    try {
      port = browser.runtime.connect({ name: EVENTS_PORT });
    } catch {
      // Extension reloaded or removed: this content script is orphaned, stop retrying.
      stopped = true;
      clearInterval(ping);
      state.connection = "offline";
      return;
    }
    port.onMessage.addListener((raw: unknown) => {
      const message = raw as PortToOverlay;
      if (message.type === "stream") {
        state.connection = message.state === "open" ? "online" : "offline";
        if (message.state === "open") void openSession(state);
        return;
      }
      const { event } = message;
      if (event.type === "annotation.deleted") removeAnnotation(state, event.id);
      else upsertAnnotation(state, event.annotation);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      if (!stopped) retry = setTimeout(connect, 1000);
    });
    port.postMessage({ type: "subscribe", sessionId: state.session.id } satisfies PortToBackground);
  };
  connect();

  return () => {
    stopped = true;
    clearInterval(ping);
    if (retry) clearTimeout(retry);
    port?.disconnect();
  };
}

export function draftFromPick(pick: Pick): Draft {
  const first = pick.elements[0];
  const label =
    pick.kind === "area"
      ? `area with ${pick.elements.length} element(s)`
      : pick.elements.length > 1
        ? `${pick.elements.length} elements`
        : first
          ? describeElement(first)
          : "element";
  return { pick, label, comment: "", intent: "fix", severity: "important", saving: false, error: null };
}

/**
 * The resolver lives in the page's MAIN world and is lost when the document is replaced between
 * the two injections (dev-server reload, for instance). The overlay asks for it again.
 */
async function ensureResolver(): Promise<void> {
  if (await pingResolver()) return;
  await send({ type: "resolver.ensure" }).catch(() => undefined);
  await pingResolver(1000);
}

async function buildTargets(elements: Element[]): Promise<Target[]> {
  await ensureResolver();
  return Promise.all(
    elements.slice(0, LIMITS.targets).map(async (element) => ({ ...buildDomContext(element), source: await requestSource(element) })),
  );
}

export async function saveDraft(state: OverlayState): Promise<void> {
  const draft = state.draft;
  if (!draft || draft.saving || !state.session || !draft.comment.trim()) return;
  draft.saving = true;
  draft.error = null;
  try {
    const targets = await buildTargets(draft.pick.elements);
    const area = draft.pick.area
      ? { ...draft.pick.area, x: draft.pick.area.x + window.scrollX, y: draft.pick.area.y + window.scrollY }
      : null;
    const input: AnnotationInput = {
      kind: draft.pick.kind,
      comment: draft.comment.trim(),
      intent: draft.intent,
      severity: draft.severity,
      targets,
      selectedText: draft.pick.selectedText,
      area,
      url: location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
    const annotation = await send({ type: "annotation.create", sessionId: state.session.id, input });
    upsertAnnotation(state, annotation);
    // The user may have started another draft while this one was saving; keep it.
    if (state.draft === draft) {
      state.draft = null;
      window.getSelection()?.removeAllRanges();
    }
  } catch (error) {
    draft.saving = false;
    draft.error = error instanceof Error ? error.message : String(error);
  }
}

export function rectsOf(elements: Element[]): Rect[] {
  return elements.map(documentRect);
}
