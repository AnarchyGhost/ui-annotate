import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Session } from "@ui-annotate/protocol";
import { baseUrl, type Config } from "./config.js";
import { HttpApi } from "./client.js";
import { scopeToProject } from "./hooks/run.js";
import { ensureDaemon } from "./launcher.js";
import { channelNotification, createMcpServer } from "./mcp.js";

/**
 * `ui-annotate mcp`: stdio MCP server proxying to the shared daemon. With `channel`, each new
 * annotation of this project is pushed into the Claude Code session as a channel notification.
 */
export async function runStdio(config: Config, options: { channel: boolean }): Promise<void> {
  const token = await ensureDaemon(config);
  const api = new HttpApi(baseUrl(config), token);
  const cwd = process.cwd();
  const mcp = createMcpServer(api, { cwd, channel: options.channel });

  let unsubscribe: (() => void) | null = null;
  let closing = false;
  // The SDK stdio transport does not watch stdin EOF; without this an orphaned process keeps
  // reconnecting to /events after the client dies.
  const shutdown = () => {
    if (closing) return;
    closing = true;
    unsubscribe?.();
    void mcp.close().finally(() => process.exit(0));
  };
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  mcp.server.onclose = shutdown;

  await mcp.connect(new StdioServerTransport());
  if (!options.channel) return;

  unsubscribe = api.subscribe((event) => {
    if (event.type !== "annotation.created") return;
    void (async () => {
      const session = await api.getSession(event.annotation.sessionId).catch(() => null);
      const sessions = new Map<string, Session>(session ? [[session.id, session]] : []);
      // Same rule as the hooks: only pages whose project root contains cwd are pushed.
      if (scopeToProject([event.annotation], sessions, cwd).project.length === 0) return;
      await mcp.server.notification(await channelNotification(api, event.annotation, cwd));
    })().catch((error: unknown) => console.error("[ui-annotate] channel notification failed:", error));
  });
}
