import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseUrl, readToken, type Config } from "./config.js";
import { API_LEVEL } from "./version.js";

/**
 * Client side of the daemon lifecycle. Kept apart from daemon.ts: importing node:sqlite fails on
 * Node < 22.13, and hooks or the stdio proxy may run on whatever `node` the agent finds.
 */
interface Health {
  name?: string;
  api?: number;
  pid?: number;
}

async function health(config: Config): Promise<Health | null> {
  try {
    const response = await fetch(`${baseUrl(config)}/health`, { signal: AbortSignal.timeout(1000) });
    const body = (await response.json()) as Health;
    return response.ok && body.name === "ui-annotate" ? body : null;
  } catch {
    return null;
  }
}

export async function isDaemonUp(config: Config): Promise<boolean> {
  return (await health(config)) !== null;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

/**
 * A daemon from before an update keeps running with the old routes (it answered the new
 * POST /pair with 401). The process that answers /health as ui-annotate with an older API level
 * is stopped by its own pid and replaced.
 */
async function stopOutdated(config: Config, running: Health): Promise<void> {
  if ((running.api ?? 1) >= API_LEVEL) return;
  if (!running.pid) throw new Error(`an older ui-annotate daemon runs on ${baseUrl(config)}; stop it and retry`);
  process.kill(running.pid, "SIGTERM");
  if (!(await waitFor(async () => !(await isDaemonUp(config)), 5000))) {
    throw new Error(`older ui-annotate daemon (pid ${running.pid}) did not stop`);
  }
}

/** Starts `ui-annotate serve` detached when no current daemon answers, then waits for /health. */
export async function ensureDaemon(config: Config): Promise<string> {
  const running = await health(config);
  if (running) await stopOutdated(config, running);
  if (!(await isDaemonUp(config))) {
    const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
    const logPath = join(dirname(config.dbPath), "daemon.log");
    mkdirSync(dirname(logPath), { recursive: true });
    const log = openSync(logPath, "a");
    const child = spawn(process.execPath, [cli, "serve"], {
      detached: true,
      stdio: ["ignore", log, log],
      env: process.env,
    });
    child.unref();
    if (!(await waitFor(() => isDaemonUp(config), 8000))) {
      throw new Error(`daemon did not start on ${baseUrl(config)}; see ${logPath}`);
    }
  }
  const token = readToken(config.tokenPath);
  if (!token) throw new Error(`token file ${config.tokenPath} is missing`);
  return token;
}
