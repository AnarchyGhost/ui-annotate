import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAGE_DATA_NOTE, formatAnnotationMarkdown, type Annotation, type Dispatch, type DispatchAgent } from "@ui-annotate/protocol";
import { LocalApi, OPEN_STATUSES } from "./api.js";
import { presentAnnotations } from "./mcp.js";
import type { Store } from "./store.js";

/** Set in the environment of a background run; the hooks stay silent there. */
export const DISPATCH_ENV = "UI_ANNOTATE_DISPATCH";

const RUN_TIMEOUT_MS = 15 * 60_000;
const OUTPUT_LIMIT = 256_000;
const ERROR_TAIL = 600;

export interface AgentCommand {
  command: string;
  args: string[];
  /** Prompt written to stdin; otherwise it is part of `args`. */
  stdin: string | null;
  /** File where the CLI writes its final message; otherwise stdout is the final message. */
  outputFile: string | null;
}

const BINARIES: Record<DispatchAgent, { env: string; name: string }> = {
  claude: { env: "UI_ANNOTATE_CLAUDE_BIN", name: "claude" },
  codex: { env: "UI_ANNOTATE_CODEX_BIN", name: "codex" },
  cursor: { env: "UI_ANNOTATE_CURSOR_BIN", name: "cursor-agent" },
};

const binary = (agent: DispatchAgent) => process.env[BINARIES[agent].env] || BINARIES[agent].name;

/**
 * Headless command of each agent, limited to reading and editing the project:
 * - claude: edit tools accepted, every other tool (Bash, web, MCP) denied in print mode;
 * - codex: no switch for the shell tool; workspace-write sandbox keeps commands inside the project, without network;
 * - cursor: --force applies edits, the sandbox confines its shell commands.
 */
export function agentCommand(agent: DispatchAgent, prompt: string, root: string, scratch: string): AgentCommand {
  switch (agent) {
    case "claude":
      return {
        command: binary(agent),
        args: ["-p", "--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write,Glob,Grep", "--output-format", "text"],
        stdin: prompt,
        outputFile: null,
      };
    case "codex": {
      const outputFile = join(scratch, "last-message.txt");
      return {
        command: binary(agent),
        args: ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", root, "-o", outputFile, "-"],
        stdin: prompt,
        outputFile,
      };
    }
    case "cursor":
      return {
        command: binary(agent),
        args: ["-p", "--force", "--sandbox", "enabled", "--trust", "--workspace", root, "--output-format", "text", prompt],
        stdin: null,
        outputFile: null,
      };
  }
}

export function dispatchPrompt(annotations: Annotation[]): string {
  const blocks = annotations.map((annotation) => formatAnnotationMarkdown(annotation, { thread: true })).join("\n\n---\n\n");
  return `The user left UI feedback on the running web app of this project (current directory) in the browser.
Handle every annotation below: open the file at the given line first, then make the change the comment asks for.
Change only files of this project. Do not start servers, install packages, commit or touch git.
${PAGE_DATA_NOTE}

${blocks}

When done, answer with one section per annotation, exactly in this form:

### <annotation id>
RESOLVED: <one or two sentences on what changed>

Use "QUESTION: <what you need to know>" instead when the request is unclear (make no change for it),
and "DISMISSED: <reason>" when it should not be done.`;
}

export type Outcome = { kind: "resolved" | "question" | "dismissed"; text: string };

const VERDICT = /^(RESOLVED|QUESTION|DISMISSED):\s*([\s\S]*)$/;

/** Verdict per annotation id from the final message; ids without a parsable section are missing. */
export function parseOutcomes(output: string, ids: string[]): Map<string, Outcome> {
  const outcomes = new Map<string, Outcome>();
  const sections = output.split(/^#{2,4}\s+/m);
  for (const section of sections) {
    const [heading = "", ...body] = section.split("\n");
    const id = ids.find((candidate) => heading.includes(candidate));
    if (!id || outcomes.has(id)) continue;
    const match = body.join("\n").trim().match(VERDICT);
    if (!match || !match[2]!.trim()) continue;
    const kind = match[1] === "RESOLVED" ? "resolved" : match[1] === "QUESTION" ? "question" : "dismissed";
    outcomes.set(id, { kind, text: match[2]!.trim().slice(0, 2000) });
  }
  return outcomes;
}

interface RunResult {
  code: number | null;
  output: string;
  error: string | null;
}

function runAgent(command: AgentCommand, cwd: string, timeoutMs: number, binaryEnv: string, signal: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(command.command, command.args, {
      cwd,
      env: { ...process.env, [DISPATCH_ENV]: "1" },
      stdio: [command.stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
      signal,
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ code: null, output: stdout, error: `timed out after ${Math.round(timeoutMs / 60_000)} min` });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-OUTPUT_LIMIT);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-OUTPUT_LIMIT);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      const hint = error.code === "ENOENT" ? ` (not found in PATH of the daemon; set ${binaryEnv})` : "";
      finish({ code: null, output: "", error: `${command.command}: ${error.message}${hint}` });
    });
    child.on("close", (code) => {
      const output = command.outputFile ? readOutput(command.outputFile) ?? stdout : stdout;
      finish({ code, output, error: code === 0 ? null : `exit code ${code}: ${(stderr || stdout).trim().slice(-ERROR_TAIL)}` });
    });
    // An agent that exits before reading the prompt closes the pipe; the exit code reports it.
    child.stdin?.on("error", () => {});
    if (command.stdin !== null) child.stdin?.end(command.stdin);
  });
}

function readOutput(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

interface ProjectQueue {
  agent: DispatchAgent;
  ids: string[];
  timer: NodeJS.Timeout | null;
  /** Quiet period over while a run of the project was busy; starts when it finishes. */
  ready: boolean;
  running: boolean;
}

export interface DispatcherOptions {
  command?: typeof agentCommand;
  timeoutMs?: number;
}

/**
 * Background agent runs for sites in automatic mode. Annotations of one project collect during
 * the delay into one run; a project has one run at a time, later annotations wait for it.
 */
export class Dispatcher {
  private readonly queues = new Map<string, ProjectQueue>();
  private readonly runs = new Set<Promise<void>>();
  private readonly command: typeof agentCommand;
  private readonly timeoutMs: number;
  private readonly abort = new AbortController();
  private closed = false;

  constructor(
    private readonly store: Store,
    options: DispatcherOptions = {},
  ) {
    this.command = options.command ?? agentCommand;
    this.timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
  }

  enqueue(annotation: Annotation, dispatch: Dispatch): void {
    if (this.closed) return;
    const root = this.store.getSession(annotation.sessionId).projectRoot;
    if (!root) {
      this.store.addMessage(annotation.id, "agent", "reply", "Automatic mode: no project root for this page, nothing started. Set Project root in the extension popup.");
      return;
    }
    const queue = this.queues.get(root) ?? { agent: dispatch.agent, ids: [], timer: null, ready: false, running: false };
    this.queues.set(root, queue);
    queue.agent = dispatch.agent;
    queue.ids.push(annotation.id);
    queue.ready = false;
    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = setTimeout(() => {
      queue.timer = null;
      queue.ready = true;
      this.startIfReady(root, queue);
    }, dispatch.delaySeconds * 1000);
  }

  /** Stops runs in progress (their annotations get a failure note) and starts nothing new. */
  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    for (const queue of this.queues.values()) if (queue.timer) clearTimeout(queue.timer);
    await Promise.all(this.runs);
  }

  /** Settles when no run is in progress or due (tests). */
  async idle(): Promise<void> {
    while (this.runs.size > 0 || [...this.queues.values()].some((queue) => queue.timer || queue.ready)) {
      await Promise.race([...this.runs, new Promise((resolve) => setTimeout(resolve, 20))]);
    }
  }

  private startIfReady(root: string, queue: ProjectQueue): void {
    if (this.closed || queue.running || !queue.ready) return;
    const ids = queue.ids.splice(0);
    queue.ready = false;
    queue.running = true;
    const run = this.run(root, queue.agent, ids).finally(() => {
      this.runs.delete(run);
      queue.running = false;
      if (queue.ids.length === 0 && !queue.timer) this.queues.delete(root);
      else this.startIfReady(root, queue);
    });
    this.runs.add(run);
  }

  private async run(root: string, agent: DispatchAgent, ids: string[]): Promise<void> {
    const open = ids.flatMap((id) => {
      try {
        const annotation = this.store.getAnnotation(id);
        return (OPEN_STATUSES as readonly string[]).includes(annotation.status) ? [annotation] : [];
      } catch {
        return [];
      }
    });
    if (open.length === 0) return;
    for (const annotation of open) {
      this.safely(() => {
        this.store.transition(annotation.id, { action: "acknowledge", role: "agent" });
        this.store.addMessage(annotation.id, "agent", "reply", `Automatic mode: ${agent} is working on it in the background.`);
      });
    }
    const scratch = mkdtempSync(join(tmpdir(), "ui-annotate-run-"));
    try {
      const presented = await presentAnnotations(new LocalApi(this.store), open, root);
      const command = this.command(agent, dispatchPrompt(presented), root, scratch);
      const result = await runAgent(command, root, this.timeoutMs, BINARIES[agent].env, this.abort.signal);
      const outcomes = parseOutcomes(result.output, open.map((annotation) => annotation.id));
      for (const annotation of open) this.safely(() => this.report(annotation.id, agent, outcomes.get(annotation.id), result));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  private report(id: string, agent: DispatchAgent, outcome: Outcome | undefined, result: RunResult): void {
    // The user may have closed or deleted it during the run.
    const current = this.store.getAnnotation(id);
    if (!(OPEN_STATUSES as readonly string[]).includes(current.status)) return;
    if (outcome?.kind === "resolved") this.store.transition(id, { action: "resolve", role: "agent", summary: outcome.text });
    else if (outcome?.kind === "dismissed") this.store.transition(id, { action: "dismiss", role: "agent", reason: outcome.text });
    else if (outcome?.kind === "question") this.store.addMessage(id, "agent", "reply", outcome.text);
    else if (result.error) this.store.addMessage(id, "agent", "reply", `Automatic mode: ${agent} run failed, ${result.error}`);
    else this.store.addMessage(id, "agent", "reply", `Automatic mode: ${agent} finished without a result for this annotation. Last output: ${result.output.trim().slice(-ERROR_TAIL)}`);
  }

  private safely(work: () => void): void {
    try {
      work();
    } catch (error) {
      if (!this.closed) console.error("[ui-annotate] dispatch:", error);
    }
  }
}
