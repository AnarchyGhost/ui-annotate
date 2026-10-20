/**
 * Hook entry: `hook.js <claude|codex|cursor> <event>`, JSON on stdin. Fails open: a missing
 * daemon, token or network error prints nothing and exits 0, so the agent is never blocked by us.
 */
import type { Session } from "@ui-annotate/protocol";
import { HttpApi } from "../client.js";
import { baseUrl, loadConfig, readToken } from "../config.js";
import { DISPATCH_ENV } from "../dispatch.js";
import { presentAnnotations } from "../mcp.js";
import { buildHookOutput, scopeToProject, type HookClient, type HookInput, type ScopedAnnotations } from "./run.js";

const CLIENTS: HookClient[] = ["claude", "codex", "cursor"];

async function readStdin(): Promise<HookInput> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookInput;
  } catch {
    return {};
  }
}

const NOTHING: ScopedAnnotations = { project: [], unscoped: 0 };

async function openAnnotations(cwd: string | null): Promise<ScopedAnnotations> {
  const config = loadConfig();
  const token = readToken(config.tokenPath);
  if (!token) return NOTHING;
  const api = new HttpApi(baseUrl(config), token);
  const open = await api.open();
  const sessions = new Map<string, Session>();
  for (const session of await api.listSessions()) sessions.set(session.id, session);
  const scoped = scopeToProject(open, sessions, cwd);
  // Same path treatment as the MCP tools: relative to the project, nothing outside it.
  return { ...scoped, project: await presentAnnotations(api, scoped.project, cwd) };
}

export async function runHook(argv: string[]): Promise<void> {
  const [clientArg, event] = argv;
  const client = CLIENTS.find((candidate) => candidate === clientArg);
  if (!client || !event) {
    console.error("usage: hook <claude|codex|cursor> <event>");
    return;
  }
  // A background run of automatic mode gets its annotations in the prompt; a digest or a Stop block would repeat them.
  if (process.env[DISPATCH_ENV]) return;
  const input = await readStdin();
  const cwd = input.cwd ?? input.workspace_roots?.[0] ?? process.cwd();
  const scoped = await openAnnotations(cwd).catch(() => NOTHING);
  const { stdout } = buildHookOutput(client, event, input, scoped);
  if (stdout) process.stdout.write(`${JSON.stringify(stdout)}\n`);
}

if (process.argv[1] && /hook\.(js|mjs|ts)$/.test(process.argv[1])) {
  runHook(process.argv.slice(2)).finally(() => process.exit(0));
}
