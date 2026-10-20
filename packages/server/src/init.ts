import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface InitPaths {
  node: string;
  cli: string;
  hook: string;
}

export function defaultPaths(): InitPaths {
  const dist = dirname(fileURLToPath(import.meta.url));
  return { node: process.execPath, cli: join(dist, "cli.js"), hook: join(dist, "hook.js") };
}

const quote = (value: string) => JSON.stringify(value);

/**
 * Codex: MCP in config.toml, hooks in hooks.json. Hook schema per codex-rs `HooksFile`;
 * user hooks run only after they are trusted once in the `/hooks` TUI.
 */
export function codexConfig(paths: InitPaths) {
  const toml = [
    "[mcp_servers.ui-annotate]",
    `command = ${quote(paths.node)}`,
    `args = [${quote(paths.cli)}, "mcp"]`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 30",
    "",
  ].join("\n");
  const hook = (event: string) => ({
    hooks: [{ type: "command", command: `${quote(paths.node)} ${quote(paths.hook)} codex ${event}`, timeout: 10 }],
  });
  const hooks = {
    hooks: {
      SessionStart: [hook("SessionStart")],
      UserPromptSubmit: [hook("UserPromptSubmit")],
      Stop: [hook("Stop")],
    },
  };
  return { toml, hooks };
}

/** Cursor: `.cursor/mcp.json` and `.cursor/hooks.json` (version 1). beforeSubmitPrompt cannot add context. */
export function cursorConfig(paths: InitPaths) {
  const mcp = { mcpServers: { "ui-annotate": { type: "stdio", command: paths.node, args: [paths.cli, "mcp"] } } };
  const hooks = {
    version: 1,
    hooks: {
      sessionStart: [{ command: `${quote(paths.node)} ${quote(paths.hook)} cursor sessionStart`, timeout: 10 }],
      stop: [{ command: `${quote(paths.node)} ${quote(paths.hook)} cursor stop`, timeout: 10, loop_limit: 2 }],
    },
  };
  return { mcp, hooks };
}

function mergeJsonFile(path: string, patch: Record<string, unknown>, mergeKey: string): void {
  const current = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  const merged = {
    ...current,
    ...patch,
    [mergeKey]: { ...((current[mergeKey] as object | undefined) ?? {}), ...(patch[mergeKey] as object) },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
}

export function runInit(target: string | undefined, write: boolean, cwd: string, log: (line: string) => void): number {
  const paths = defaultPaths();
  if (target === "codex") {
    const { toml, hooks } = codexConfig(paths);
    const configPath = join(homedir(), ".codex", "config.toml");
    const hooksPath = join(homedir(), ".codex", "hooks.json");
    if (!write) {
      log(`# ${configPath}\n${toml}\n# ${hooksPath}\n${JSON.stringify(hooks, null, 2)}`);
      log("\nAfter writing, open Codex and trust the hooks once with /hooks.");
      return 0;
    }
    const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    if (existing.includes("[mcp_servers.ui-annotate]")) {
      log(`${configPath} already has [mcp_servers.ui-annotate]; left as is.`);
    } else {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}\n${toml}`);
      log(`appended [mcp_servers.ui-annotate] to ${configPath}`);
    }
    mergeJsonFile(hooksPath, hooks, "hooks");
    log(`wrote hooks to ${hooksPath}; trust them once in Codex with /hooks`);
    return 0;
  }
  if (target === "cursor") {
    const { mcp, hooks } = cursorConfig(paths);
    const mcpPath = join(cwd, ".cursor", "mcp.json");
    const hooksPath = join(cwd, ".cursor", "hooks.json");
    if (!write) {
      log(`# ${mcpPath}\n${JSON.stringify(mcp, null, 2)}\n# ${hooksPath}\n${JSON.stringify(hooks, null, 2)}`);
      return 0;
    }
    mergeJsonFile(mcpPath, mcp, "mcpServers");
    mergeJsonFile(hooksPath, hooks, "hooks");
    log(`wrote ${mcpPath} and ${hooksPath}`);
    return 0;
  }
  log("usage: ui-annotate init <codex|cursor> [--write]");
  return 1;
}
