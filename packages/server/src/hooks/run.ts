import { HOOK_CONTEXT_LIMIT, formatPendingDigest, type Annotation, type Session } from "@ui-annotate/protocol";
import { deliveredTo, withinRoot } from "../domain.js";

export type HookClient = "claude" | "codex" | "cursor";

export interface HookInput {
  hook_event_name?: string;
  cwd?: string;
  stop_hook_active?: boolean;
  /** Cursor stop hook. */
  loop_count?: number;
  status?: string;
  workspace_roots?: string[];
}

export interface HookOutput {
  /** JSON written to stdout; null means print nothing and exit 0. */
  stdout: Record<string, unknown> | null;
}

/** Cursor keeps sending stop follow-ups up to loop_limit (default 5); stop nagging earlier. */
const CURSOR_MAX_FOLLOWUPS = 2;

export interface ScopedAnnotations {
  /** Pages whose project root contains the agent's cwd. */
  project: Annotation[];
  /** Pages without a project root: could belong to any project, so only counted. */
  unscoped: number;
  /** This project's annotations sent to another live session or a background run: only counted. */
  elsewhere: number;
}

/**
 * Splits open annotations by the page's project root (the daemon is shared across projects).
 * Annotations of other projects are dropped. Only this project's annotations for this session
 * (`clientPid`: CLAUDE_PID of the hook, null for other agents) reach the agent's context and
 * block Stop; the text of root-less pages stays behind get_pending. `livePids`: live sessions per
 * page session id, see `deliveredTo`.
 */
export function scopeToProject(
  annotations: Annotation[],
  sessions: Map<string, Session>,
  cwd: string | null,
  clientPid: number | null = null,
  livePids?: Map<string, number[]>,
): ScopedAnnotations {
  const scoped: ScopedAnnotations = { project: [], unscoped: 0, elsewhere: 0 };
  for (const annotation of annotations) {
    const root = sessions.get(annotation.sessionId)?.projectRoot;
    if (!root || !cwd) {
      scoped.unscoped += 1;
      continue;
    }
    if (!withinRoot(cwd, root)) continue;
    if (deliveredTo(annotation, clientPid, livePids?.get(annotation.sessionId))) scoped.project.push(annotation);
    else scoped.elsewhere += 1;
  }
  return scoped;
}

function elsewhereLine(count: number): string {
  return `ui-annotate: ${count} open annotation(s) of this project are sent to another Claude Code session or a background agent run; leave them to it.`;
}

function stopReason(count: number): string {
  return `ui-annotate: ${count} open UI annotation(s) from the browser are not resolved. Call get_pending, fix each one and call resolve, or reply/dismiss when it cannot be done now.`;
}

function unscopedLine(count: number): string {
  return `ui-annotate: ${count} open annotation(s) from pages without a project root; call get_pending to see them, or set Project root for the page in the extension popup.`;
}

export function buildHookOutput(client: HookClient, event: string, input: HookInput, scoped: ScopedAnnotations): HookOutput {
  const normalized = event.toLowerCase();
  const open = scoped.project;
  if (open.length === 0 && scoped.unscoped === 0 && scoped.elsewhere === 0) return { stdout: null };

  if (normalized === "stop") {
    if (open.length === 0) return { stdout: null };
    if (client === "cursor") {
      if (input.status && input.status !== "completed") return { stdout: null };
      if ((input.loop_count ?? 0) >= CURSOR_MAX_FOLLOWUPS) return { stdout: null };
      return { stdout: { followup_message: stopReason(open.length) } };
    }
    if (input.stop_hook_active) return { stdout: null };
    return { stdout: { decision: "block", reason: stopReason(open.length) } };
  }

  const tail = [scoped.unscoped > 0 ? unscopedLine(scoped.unscoped) : "", scoped.elsewhere > 0 ? elsewhereLine(scoped.elsewhere) : ""]
    .filter(Boolean)
    .join("\n\n");
  const budget = HOOK_CONTEXT_LIMIT - (tail ? tail.length + 2 : 0);
  const digest = [formatPendingDigest(open, budget), tail].filter(Boolean).join("\n\n");
  if (client === "cursor") {
    return normalized === "sessionstart" ? { stdout: { additional_context: digest } } : { stdout: null };
  }
  if (normalized === "sessionstart" || normalized === "userpromptsubmit") {
    const hookEventName = normalized === "sessionstart" ? "SessionStart" : "UserPromptSubmit";
    return { stdout: { hookSpecificOutput: { hookEventName, additionalContext: digest } } };
  }
  return { stdout: null };
}
