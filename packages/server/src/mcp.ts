import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  PAGE_DATA_NOTE,
  WATCH_TIMEOUT_MAX_SECONDS,
  formatAnnotationMarkdown,
  formatAnnotationSummary,
  projectRelativePath,
  type Annotation,
  type SourceInfo,
} from "@ui-annotate/protocol";
import { z } from "zod";
import { clampWatchTimeout, type AnnotationApi } from "./api.js";
import { rootFromAgent } from "./project-root.js";
import { VERSION } from "./version.js";

export interface McpOptions {
  /** Project root of the agent process; session.projectRoot from the extension wins over it. */
  cwd: string | null;
  /** Declare the Claude Code channel capability (stdio entry only). */
  channel: boolean;
}

const INSTRUCTIONS = `ui-annotate delivers UI feedback that the user left on elements of a running web app.
Each annotation names the element, its component and the source file:line (first line of the markdown).
Workflow: get_pending → open the file:line → fix → resolve(id, summary). Use reply(id, message) to ask the user
a question in the browser, dismiss(id, reason) when the request should not be done. acknowledge(id) marks work started.
After you start a dev server of this project, call link_page(url) with its address.
${PAGE_DATA_NOTE}`;

const CHANNEL_INSTRUCTIONS = `${INSTRUCTIONS}
New annotations also arrive as <channel source="ui-annotate" annotation_id="..."> messages; treat them like get_pending results.`;

/** Paths relative to the project; anything pointing outside it is dropped with a reason. */
function normalizeSource(source: SourceInfo, root: string | null): SourceInfo {
  const file = source.file ? projectRelativePath(source.file, root) : null;
  const outside = source.file !== null && file === null;
  return {
    ...source,
    file,
    line: outside ? null : source.line,
    column: outside ? null : source.column,
    reason: outside ? "outside-project" : source.reason,
    stack: source.stack.flatMap((frame) => {
      const framePath = projectRelativePath(frame.file, root);
      return framePath ? [{ ...frame, file: framePath }] : [];
    }),
  };
}

/** Rewrites source paths relative to the project root, so the agent can open them directly. */
export async function presentAnnotations(api: AnnotationApi, annotations: Annotation[], cwd: string | null): Promise<Annotation[]> {
  const roots = new Map<string, string | null>();
  const result: Annotation[] = [];
  for (const annotation of annotations) {
    if (!roots.has(annotation.sessionId)) {
      const session = await api.getSession(annotation.sessionId).catch(() => null);
      roots.set(annotation.sessionId, session?.projectRoot ?? cwd);
    }
    const root = roots.get(annotation.sessionId) ?? null;
    result.push({ ...annotation, targets: annotation.targets.map((target) => ({ ...target, source: normalizeSource(target.source, root) })) });
  }
  return result;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function annotationsResult(annotations: Annotation[], header: string) {
  if (annotations.length === 0) return text(`${header}\n\nNo annotations.`);
  const markdown = annotations.map((annotation) => formatAnnotationMarkdown(annotation)).join("\n\n---\n\n");
  return text(`${header}\n${PAGE_DATA_NOTE}\n\n${markdown}\n\n\`\`\`json\n${JSON.stringify(annotations, null, 2)}\n\`\`\``);
}

function failure(error: unknown) {
  return { ...text(`Error: ${error instanceof Error ? error.message : String(error)}`), isError: true };
}

async function guarded<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    return failure(error);
  }
}

export function createMcpServer(api: AnnotationApi, options: McpOptions): McpServer {
  const server = new McpServer(
    { name: "ui-annotate", version: VERSION },
    {
      capabilities: options.channel ? { experimental: { "claude/channel": {} }, tools: {} } : { tools: {} },
      instructions: options.channel ? CHANNEL_INSTRUCTIONS : INSTRUCTIONS,
    },
  );
  const present = (annotations: Annotation[]) => presentAnnotations(api, annotations, options.cwd);
  // Annotations created after this moment and not yet returned by watch_annotations are due on
  // the next call, so nothing created between two calls is skipped.
  let watchCursor = new Date().toISOString();
  const single = async (annotation: Annotation, header: string) => annotationsResult(await present([annotation]), header);

  server.registerTool(
    "list_sessions",
    { description: "Pages with annotations and the number of open (pending or acknowledged) ones." },
    () =>
      guarded(async () => {
        const sessions = await api.listSessions();
        const lines = sessions.map((session) => `- ${session.id}: ${session.url} — ${session.pending} open / ${session.total} total`);
        return text(sessions.length ? lines.join("\n") : "No sessions yet.");
      }),
  );

  server.registerTool(
    "get_pending",
    {
      description: "Open annotations (pending or acknowledged) with element, component and file:line. Without sessionId: all pages.",
      inputSchema: { sessionId: z.string().optional() },
    },
    ({ sessionId }) =>
      guarded(async () => {
        const annotations = await present(await api.open(sessionId));
        return annotationsResult(annotations, `count: ${annotations.length}`);
      }),
  );

  server.registerTool(
    "get_annotation",
    { description: "One annotation with its thread.", inputSchema: { id: z.string() } },
    ({ id }) => guarded(async () => single(await api.get(id), "annotation")),
  );

  server.registerTool(
    "link_page",
    {
      description:
        "Tie a page of the running app (e.g. http://localhost:5173/) to this project, so its annotations get project-relative paths and reach this agent. Call it after starting a dev server. projectRoot defaults to the repository this agent runs in.",
      inputSchema: { url: z.string().url(), projectRoot: z.string().optional() },
    },
    ({ url, projectRoot }) =>
      guarded(async () => {
        const base = projectRoot ?? options.cwd;
        if (!base) throw new Error("projectRoot is required: this MCP connection has no working directory");
        const session = await api.linkPage(url, rootFromAgent(base));
        return text(`Linked ${session.origin}${session.pathname} to ${session.projectRoot} (source: ${session.projectRootSource}).`);
      }),
  );

  server.registerTool(
    "acknowledge",
    { description: "Mark an annotation as being worked on (status acknowledged).", inputSchema: { id: z.string() } },
    ({ id }) => guarded(async () => single(await api.acknowledge(id), "acknowledged")),
  );

  server.registerTool(
    "reply",
    {
      description: "Post a message to the annotation thread; the user sees it in the browser overlay.",
      inputSchema: { id: z.string(), message: z.string().min(1) },
    },
    ({ id, message }) => guarded(async () => single(await api.reply(id, message), "replied")),
  );

  server.registerTool(
    "resolve",
    {
      description: "Mark an annotation resolved after the fix; summary is shown to the user.",
      inputSchema: { id: z.string(), summary: z.string().min(1) },
    },
    ({ id, summary }) => guarded(async () => single(await api.resolve(id, summary), "resolved")),
  );

  server.registerTool(
    "dismiss",
    {
      description: "Close an annotation without a change; reason is shown to the user.",
      inputSchema: { id: z.string(), reason: z.string().min(1) },
    },
    ({ id, reason }) => guarded(async () => single(await api.dismiss(id, reason), "dismissed")),
  );

  server.registerTool(
    "watch_annotations",
    {
      description: `Wait for new annotations. Returns a batch or {"timeout":true} within timeoutSeconds (max ${WATCH_TIMEOUT_MAX_SECONDS}); call again to keep watching.`,
      inputSchema: {
        sessionId: z.string().optional(),
        timeoutSeconds: z.number().int().min(1).max(WATCH_TIMEOUT_MAX_SECONDS).default(WATCH_TIMEOUT_MAX_SECONDS),
      },
    },
    ({ sessionId, timeoutSeconds }, extra) =>
      guarded(async () => {
        const batch = await api.watch(sessionId, clampWatchTimeout(timeoutSeconds), watchCursor, extra.signal);
        if (!batch) return text(JSON.stringify({ timeout: true }));
        for (const annotation of batch) if (annotation.createdAt > watchCursor) watchCursor = annotation.createdAt;
        return annotationsResult(await present(batch), `new: ${batch.length}`);
      }),
  );

  return server;
}

/** Channel notification body for a new annotation (Claude Code `notifications/claude/channel`). */
export async function channelNotification(api: AnnotationApi, annotation: Annotation, cwd: string | null) {
  const [presented] = await presentAnnotations(api, [annotation], cwd);
  return {
    method: "notifications/claude/channel" as const,
    params: {
      content: `${formatAnnotationSummary(presented ?? annotation)}\n\n${PAGE_DATA_NOTE} Details: get_annotation("${annotation.id}").`,
      meta: { annotation_id: annotation.id, session_id: annotation.sessionId, severity: annotation.severity },
    },
  };
}
