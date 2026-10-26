import { z } from "zod";
import { LIMITS } from "./limits.js";

/** String truncated to `max` characters; input from the page is untrusted and may be huge. */
const text = (max: number) => z.string().transform((value) => value.slice(0, max));
const nullableText = (max: number) => text(max).nullable().default(null);
const int = z.number().int().finite();

export const Framework = z.enum(["vue", "react", "svelte", "angular", "solid", "preact"]);
export type Framework = z.infer<typeof Framework>;

export const SourceReason = z.enum(["production-build", "no-framework", "no-line", "outside-project"]);
export type SourceReason = z.infer<typeof SourceReason>;

export const SourceFrame = z.object({
  file: text(LIMITS.filePath),
  line: int.positive().nullable(),
  column: int.positive().nullable(),
  componentName: nullableText(LIMITS.componentName),
});
export type SourceFrame = z.infer<typeof SourceFrame>;

export const SourceInfo = z.object({
  framework: Framework.nullable().default(null),
  componentName: nullableText(LIMITS.componentName),
  file: nullableText(LIMITS.filePath),
  line: int.positive().nullable().default(null),
  column: int.positive().nullable().default(null),
  /** Where the line came from: a build-plugin attribute or framework runtime internals. */
  via: z.enum(["attribute", "runtime"]).nullable().default(null),
  attribute: nullableText(64),
  stack: z
    .array(SourceFrame)
    .transform((frames) => frames.slice(0, LIMITS.stackFrames))
    .default([]),
  reason: SourceReason.nullable().default(null),
});
export type SourceInfo = z.infer<typeof SourceInfo>;

export const Rect = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});
export type Rect = z.infer<typeof Rect>;

const boundedRecord = (maxEntries: number, maxValue: number) =>
  z
    .record(z.string().max(64), z.string())
    .transform((record) =>
      Object.fromEntries(
        Object.entries(record)
          .slice(0, maxEntries)
          .map(([key, value]) => [key, value.slice(0, maxValue)]),
      ),
    );

export const Accessibility = z.object({
  role: nullableText(64),
  name: nullableText(LIMITS.element),
  attributes: boundedRecord(LIMITS.ariaEntries, LIMITS.styleValue).default({}),
});
export type Accessibility = z.infer<typeof Accessibility>;

/** One annotated DOM element with its context and source location. */
export const Target = z.object({
  element: text(LIMITS.element),
  selector: text(LIMITS.selector),
  elementPath: text(LIMITS.elementPath),
  nearbyText: nullableText(LIMITS.nearbyText),
  computedStyles: boundedRecord(LIMITS.styleEntries, LIMITS.styleValue).default({}),
  accessibility: Accessibility.default({ role: null, name: null, attributes: {} }),
  boundingBox: Rect,
  source: SourceInfo,
});
export type Target = z.infer<typeof Target>;

export const AnnotationStatus = z.enum(["pending", "acknowledged", "resolved", "dismissed"]);
export type AnnotationStatus = z.infer<typeof AnnotationStatus>;

export const Intent = z.enum(["fix", "change", "question", "approve"]);
export type Intent = z.infer<typeof Intent>;

export const Severity = z.enum(["blocking", "important", "minor"]);
export type Severity = z.infer<typeof Severity>;

export const AnnotationKind = z.enum(["element", "text", "multi", "area"]);
export type AnnotationKind = z.infer<typeof AnnotationKind>;

export const ThreadRole = z.enum(["user", "agent"]);
export type ThreadRole = z.infer<typeof ThreadRole>;

export const ThreadKind = z.enum(["comment", "reply", "acknowledge", "resolve", "dismiss", "reopen"]);
export type ThreadKind = z.infer<typeof ThreadKind>;

export const ThreadMessage = z.object({
  id: z.string(),
  role: ThreadRole,
  kind: ThreadKind,
  body: z.string(),
  createdAt: z.string(),
});
export type ThreadMessage = z.infer<typeof ThreadMessage>;

export const Viewport = z.object({
  width: int.nonnegative(),
  height: int.nonnegative(),
});
export type Viewport = z.infer<typeof Viewport>;

export const DispatchAgent = z.enum(["claude", "codex", "cursor"]);
export type DispatchAgent = z.infer<typeof DispatchAgent>;

/** Hand the annotation to a background agent run (Background agent mode of the site). */
export const Dispatch = z.object({
  agent: DispatchAgent,
  /** Quiet period before the run; annotations arriving meanwhile join the same run. 0: at once. */
  delaySeconds: z.number().int().min(0).max(600),
});
export type Dispatch = z.infer<typeof Dispatch>;

/**
 * Who gets the annotation, chosen per site in the popup:
 * - off: every agent session of the project (channel and hooks);
 * - session: one live Claude Code session, identified by the PID of its `claude` process;
 * - background: a background agent run of the daemon, hidden from the live sessions.
 */
export const Delivery = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }),
  z.object({ mode: z.literal("session"), clientPid: int.positive().nullable() }),
  Dispatch.extend({ mode: z.literal("background") }),
]);
export type Delivery = z.infer<typeof Delivery>;

export const DELIVERY_OFF: Delivery = { mode: "off" };

/** A Claude Code session whose ui-annotate channel is connected to the daemon. */
export const LiveClient = z.object({
  /** PID of the `claude` process; hooks of the same session see it as CLAUDE_PID. */
  pid: int.positive(),
  cwd: z.string(),
  /** Session name (/rename) and state, read from Claude Code's session file when present. */
  name: z.string().nullable(),
  status: z.enum(["idle", "busy"]).nullable(),
  /** CLAUDE_CODE_ENTRYPOINT: `cli` for a terminal, `sdk-cli` for Remote Control and background sessions. */
  entrypoint: z.string().nullable(),
  connectedAt: z.string(),
});
export type LiveClient = z.infer<typeof LiveClient>;

/** Body of POST /sessions/:id/annotations. */
export const AnnotationInput = z.object({
  kind: AnnotationKind,
  comment: z.string().min(1).max(LIMITS.comment),
  intent: Intent.default("fix"),
  severity: Severity.default("important"),
  targets: z.array(Target).min(1).max(LIMITS.targets),
  selectedText: nullableText(LIMITS.selectedText),
  area: Rect.nullable().default(null),
  url: text(LIMITS.url),
  viewport: Viewport,
  delivery: Delivery.nullable().default(null),
  /** API level 4 form of `delivery: { mode: "background" }`, still sent by older extensions. */
  dispatch: Dispatch.nullable().default(null),
});
export type AnnotationInput = z.input<typeof AnnotationInput>;
export type ParsedAnnotationInput = z.infer<typeof AnnotationInput>;

/** Body of PATCH /annotations/:id, sent by the overlay. */
export const AnnotationPatch = z
  .object({
    comment: z.string().min(1).max(LIMITS.comment),
    intent: Intent,
    severity: Severity,
    status: AnnotationStatus,
  })
  .partial();
export type AnnotationPatch = z.infer<typeof AnnotationPatch>;

/** Body of POST /annotations/:id/thread, sent by the overlay. */
export const ThreadInput = z.object({
  body: z.string().min(1).max(LIMITS.threadMessage),
});
export type ThreadInput = z.infer<typeof ThreadInput>;

export const Annotation = z.object({
  id: z.string(),
  sessionId: z.string(),
  number: int.positive(),
  status: AnnotationStatus,
  kind: AnnotationKind,
  comment: z.string(),
  intent: Intent,
  severity: Severity,
  targets: z.array(Target),
  selectedText: z.string().nullable(),
  area: Rect.nullable(),
  url: z.string(),
  viewport: Viewport,
  /** Absent in events of a daemon older than API level 5. */
  delivery: Delivery.default(DELIVERY_OFF),
  resolvedBy: ThreadRole.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  thread: z.array(ThreadMessage),
});
export type Annotation = z.infer<typeof Annotation>;

/** Body of POST /sessions: the overlay asks for the session of the current page. */
export const SessionInput = z.object({
  url: z.string().url().max(LIMITS.url),
  title: text(LIMITS.title).default(""),
  includeHash: z.boolean().default(false),
  projectRoot: nullableText(LIMITS.filePath),
});
export type SessionInput = z.input<typeof SessionInput>;

/** Where the project root came from: popup setting, link_page of an agent, dev-server process, source path. */
export const ProjectRootSource = z.enum(["manual", "agent", "port", "path"]);
export type ProjectRootSource = z.infer<typeof ProjectRootSource>;

export const Session = z.object({
  id: z.string(),
  origin: z.string(),
  pathname: z.string(),
  url: z.string(),
  title: z.string(),
  projectRoot: z.string().nullable(),
  projectRootSource: ProjectRootSource.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Session = z.infer<typeof Session>;

export const SessionSummary = Session.extend({
  pending: int.nonnegative(),
  total: int.nonnegative(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const ServerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("annotation.created"), annotation: Annotation }),
  z.object({ type: z.literal("annotation.updated"), annotation: Annotation }),
  z.object({
    type: z.literal("annotation.deleted"),
    id: z.string(),
    sessionId: z.string(),
  }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
