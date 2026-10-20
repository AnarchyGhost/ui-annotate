import type { Annotation, AnnotationStatus, ProjectRootSource, ThreadKind, ThreadRole } from "@ui-annotate/protocol";

/** Status change requested by the agent (MCP tools) or the user (overlay). */
export type Transition =
  | { action: "acknowledge"; role: ThreadRole }
  | { action: "resolve"; role: ThreadRole; summary: string }
  | { action: "dismiss"; role: ThreadRole; reason: string }
  | { action: "reopen"; role: ThreadRole };

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionError";
  }
}

export interface TransitionResult {
  status: AnnotationStatus;
  resolvedBy: ThreadRole | null;
  message: { role: ThreadRole; kind: ThreadKind; body: string } | null;
}

const OPEN: AnnotationStatus[] = ["pending", "acknowledged"];
const CLOSED: AnnotationStatus[] = ["resolved", "dismissed"];

/**
 * pending → acknowledged → resolved | dismissed; resolve and dismiss also work straight from
 * pending. A closed annotation reopens to pending. Acknowledge is idempotent so agents can
 * call it blindly; every other no-op transition is an error the agent sees.
 */
export function applyTransition(annotation: Pick<Annotation, "status">, transition: Transition): TransitionResult {
  const { status } = annotation;
  switch (transition.action) {
    case "acknowledge":
      if (status === "acknowledged") return { status, resolvedBy: null, message: null };
      if (status !== "pending") throw new TransitionError(`cannot acknowledge a ${status} annotation`);
      return { status: "acknowledged", resolvedBy: null, message: { role: transition.role, kind: "acknowledge", body: "" } };
    case "resolve":
      if (!OPEN.includes(status)) throw new TransitionError(`annotation is already ${status}`);
      return {
        status: "resolved",
        resolvedBy: transition.role,
        message: { role: transition.role, kind: "resolve", body: transition.summary },
      };
    case "dismiss":
      if (!OPEN.includes(status)) throw new TransitionError(`annotation is already ${status}`);
      return {
        status: "dismissed",
        resolvedBy: transition.role,
        message: { role: transition.role, kind: "dismiss", body: transition.reason },
      };
    case "reopen":
      if (!CLOSED.includes(status)) throw new TransitionError(`annotation is ${status}, nothing to reopen`);
      return { status: "pending", resolvedBy: null, message: { role: transition.role, kind: "reopen", body: "" } };
  }
}

/** Status sent by the overlay in PATCH maps to a transition; same status is a no-op. */
export function transitionForStatus(current: AnnotationStatus, target: AnnotationStatus): Transition | null {
  if (current === target) return null;
  switch (target) {
    case "pending":
      return { action: "reopen", role: "user" };
    case "acknowledged":
      return { action: "acknowledge", role: "user" };
    case "resolved":
      return { action: "resolve", role: "user", summary: "" };
    case "dismissed":
      return { action: "dismiss", role: "user", reason: "" };
  }
}

const ROOT_RANK: Record<ProjectRootSource, number> = { manual: 3, agent: 2, port: 1, path: 1 };

/**
 * Whether a project root from `next` replaces the current one: the popup setting wins over an
 * agent's link_page, which wins over automatic detection; detection only fills an empty root.
 */
export function replacesRoot(current: ProjectRootSource | null, next: ProjectRootSource): boolean {
  if (current === null) return true;
  if (next === "port" || next === "path") return false;
  return ROOT_RANK[next] >= ROOT_RANK[current];
}

/** Sessions are keyed by origin + pathname; the hash joins in only when the page routes by hash. */
export function sessionKey(url: URL, includeHash: boolean): { origin: string; pathname: string; key: string } {
  const pathname = includeHash && url.hash ? `${url.pathname}${url.hash}` : url.pathname;
  return { origin: url.origin, pathname, key: `${url.origin}${pathname}` };
}
