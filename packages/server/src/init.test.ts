import { describe, expect, it } from "vitest";
import { codexConfig, cursorConfig } from "./init.js";

const paths = { node: "/usr/bin/node", cli: "/opt/ui-annotate/dist/cli.js", hook: "/opt/ui-annotate/dist/hook.js" };

describe("codex config", () => {
  it("registers the stdio MCP server with a tool timeout above the 25 s watch", () => {
    const { toml } = codexConfig(paths);
    expect(toml).toContain("[mcp_servers.ui-annotate]");
    expect(toml).toContain('command = "/usr/bin/node"');
    expect(toml).toContain('args = ["/opt/ui-annotate/dist/cli.js", "mcp"]');
    expect(toml).toMatch(/tool_timeout_sec = (\d+)/);
    expect(Number(toml.match(/tool_timeout_sec = (\d+)/)![1])).toBeGreaterThan(25);
  });

  it("writes SessionStart, UserPromptSubmit and Stop command hooks", () => {
    const { hooks } = codexConfig(paths);
    expect(Object.keys(hooks.hooks)).toEqual(["SessionStart", "UserPromptSubmit", "Stop"]);
    expect(hooks.hooks.Stop[0]!.hooks[0]).toEqual({
      type: "command",
      command: '"/usr/bin/node" "/opt/ui-annotate/dist/hook.js" codex Stop',
      timeout: 10,
    });
  });
});

describe("cursor config", () => {
  it("uses mcpServers and version 1 hooks with sessionStart and a bounded stop", () => {
    const { mcp, hooks } = cursorConfig(paths);
    expect(mcp.mcpServers["ui-annotate"]).toEqual({ type: "stdio", command: "/usr/bin/node", args: ["/opt/ui-annotate/dist/cli.js", "mcp"] });
    expect(hooks.version).toBe(1);
    expect(Object.keys(hooks.hooks)).toEqual(["sessionStart", "stop"]);
    expect(hooks.hooks.stop[0]).toMatchObject({ loop_limit: 2 });
  });
});
