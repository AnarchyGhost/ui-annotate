import { parseArgs } from "node:util";
import { baseUrl, ensureToken, loadConfig } from "./config.js";
import { runHook } from "./hooks/cli.js";
import { runInit } from "./init.js";
import { isDaemonUp } from "./launcher.js";
import { writePairing } from "./pairing.js";
import { runStdio } from "./stdio.js";
import { VERSION } from "./version.js";

/** node:sqlite exists from Node 22.13 without a flag; only `serve` needs it. */
function assertSqliteNode(): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`ui-annotate serve needs Node.js >= 22.13 (node:sqlite); running ${process.version} at ${process.execPath}`);
  }
}

const USAGE = `ui-annotate ${VERSION}

Usage:
  ui-annotate serve [--port N]        run the daemon on 127.0.0.1 (default port 4848)
  ui-annotate mcp [--channel]         stdio MCP server; starts the daemon when needed
  ui-annotate token                   print the token (the extension pairs automatically; manual fallback)
  ui-annotate unpair                  forget the paired Firefox extension install
  ui-annotate status                  show whether the daemon is running
  ui-annotate init <codex|cursor> [--write]   print or write client configuration
  ui-annotate hook <claude|codex|cursor> <event>   hook entry (JSON on stdin)
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      port: { type: "string" },
      channel: { type: "boolean" },
      write: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.port) process.env.UI_ANNOTATE_PORT = String(values.port);
  const config = loadConfig();

  switch (command) {
    case "serve": {
      assertSqliteNode();
      const { startDaemon } = await import("./daemon.js");
      const daemon = await startDaemon(config);
      console.error(`[ui-annotate] listening on ${baseUrl(config)} (db ${config.dbPath})`);
      const stop = () => void daemon.close().then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return new Promise<number>(() => {});
    }
    case "mcp":
      await runStdio(config, { channel: values.channel === true });
      return new Promise<number>(() => {});
    case "token":
      console.log(ensureToken(config.tokenPath));
      return 0;
    case "unpair":
      writePairing(config.pairingPath, { firefox: null });
      console.log("Firefox pairing reset; the next Firefox install of the extension pairs on first use.");
      return 0;
    case "status": {
      const up = await isDaemonUp(config);
      console.log(up ? `running on ${baseUrl(config)}` : `not running (${baseUrl(config)})`);
      return up ? 0 : 1;
    }
    case "init":
      return runInit(rest[0], values.write === true, process.cwd(), (line) => console.log(line));
    case "hook":
      await runHook(rest);
      return 0;
    default:
      console.log(USAGE);
      return command || !values.help ? 1 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`[ui-annotate] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
