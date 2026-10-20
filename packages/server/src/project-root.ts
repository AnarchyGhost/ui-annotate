import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { normalizeSourcePath, type SourceInfo } from "@ui-annotate/protocol";

const execFileAsync = promisify(execFile);

/**
 * Automatic project root of a page, from data that exists, in this order of trust:
 * - port: the process listening on the page's localhost port and its working directory (OS data);
 * - path: absolute source paths in an annotation (page data, so only accepted with a project
 *   marker; port and agent need only a repository);
 * Never the home directory, the file system root or above.
 * - agent: the MCP client tells it with link_page (handled by the caller).
 * Each candidate directory is lifted to its git top level: agents work from the repo root.
 */
export type RootSource = "manual" | "agent" | "port" | "path";

const PROJECT_MARKERS = ["package.json", "angular.json", "pnpm-workspace.yaml", "deno.json", "bun.lockb"];

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Nearest directory upwards containing `.git` (a directory, or a file in worktrees). */
export function gitTopLevel(start: string): string | null {
  let current = resolve(start);
  if (!isDirectory(current)) current = dirname(current);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Never the file system root, the home directory or anything above it. */
export function safeRoot(root: string, home = homedir()): boolean {
  const normalized = resolve(root);
  const homeNormalized = resolve(home);
  if (normalized === sep || normalized === homeNormalized) return false;
  return !homeNormalized.startsWith(`${normalized}${sep}`);
}

const hasMarker = (directory: string) => PROJECT_MARKERS.some((marker) => existsSync(join(directory, marker)));

/** A safe root with a project marker: the bar for paths that come from the page. */
export function acceptableRoot(root: string, home = homedir()): boolean {
  return safeRoot(root, home) && hasMarker(resolve(root));
}

/**
 * The repository top level of `directory`, else the nearest directory with a project marker.
 * `requireMarker` is for page-derived paths: a forged path into some other repository of the
 * user (dotfiles, notes) must not make it the project.
 */
function liftToRoot(directory: string, home: string, requireMarker: boolean): string | null {
  const top = gitTopLevel(directory);
  if (top && safeRoot(top, home) && (!requireMarker || hasMarker(top))) return top;
  let current = resolve(directory);
  for (;;) {
    if (acceptableRoot(current, home)) return current;
    const parent = dirname(current);
    if (parent === current || current === resolve(home)) return null;
    current = parent;
  }
}

/** Root from absolute source paths of an annotation (Vue __file, React 18 __source, code-inspector). */
export function rootFromSources(sources: SourceInfo[], home = homedir()): string | null {
  const files = sources.flatMap((source) => [source.file, ...source.stack.map((frame) => frame.file)]);
  for (const raw of files) {
    if (!raw) continue;
    const path = normalizeSourcePath(raw, null);
    if (!isAbsolute(path) || !existsSync(dirname(path))) continue;
    const root = liftToRoot(dirname(path), home, true);
    if (root) return root;
  }
  return null;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function localPort(pageUrl: string): number | null {
  try {
    const url = new URL(pageUrl);
    if (!LOCAL_HOSTS.has(url.hostname)) return null;
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}

/** Socket inodes in LISTEN state on `port`, from /proc/net/tcp{,6}. */
function listeningInodes(port: number): Set<string> {
  const inodes = new Set<string>();
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = readFileSync(table, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      const local = fields[1];
      const state = fields[3];
      const inode = fields[9];
      if (local?.endsWith(`:${hexPort}`) && state === "0A" && inode && inode !== "0") inodes.add(inode);
    }
  }
  return inodes;
}

/** Linux: the process owning a listening socket, through /proc/<pid>/fd links (own processes only). */
function linuxListenerCwd(port: number): string | null {
  const inodes = listeningInodes(port);
  if (inodes.size === 0) return null;
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const match = target.match(/^socket:\[(\d+)\]$/);
      if (match?.[1] && inodes.has(match[1])) {
        try {
          return readlinkSync(`/proc/${pid}/cwd`);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** macOS: lsof gives the listening pid and its cwd. */
async function macListenerCwd(port: number): Promise<string | null> {
  try {
    const { stdout: pids } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { timeout: 2000 });
    const pid = pids.match(/^p(\d+)/m)?.[1];
    if (!pid) return null;
    const { stdout } = await execFileAsync("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], { timeout: 2000 });
    return stdout.match(/^n(.+)$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Root from the dev server behind a localhost page. A proxy (nginx, docker) on the port has its
 * working directory outside the home directory or without a project, and yields null.
 */
export async function rootFromPort(pageUrl: string, home = homedir()): Promise<string | null> {
  const port = localPort(pageUrl);
  if (port === null) return null;
  const os = platform();
  const cwd = os === "linux" ? linuxListenerCwd(port) : os === "darwin" ? await macListenerCwd(port) : null;
  if (!cwd || !resolve(cwd).startsWith(`${resolve(home)}${sep}`)) return null;
  return liftToRoot(cwd, home, false);
}

/**
 * Root for link_page: the agent's working directory lifted to its repository. An agent started in
 * the home directory would otherwise make ~ the root, and paths like .ssh/… would pass the filter.
 */
export function rootFromAgent(cwd: string, home = homedir()): string {
  const root = liftToRoot(cwd, home, false) ?? (safeRoot(cwd, home) ? resolve(cwd) : null);
  if (!root) throw new Error(`${cwd} is not inside a project: run link_page from the project directory`);
  return root;
}
