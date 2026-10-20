import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_HOST, DEFAULT_PORT } from "@ui-annotate/protocol";

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  tokenPath: string;
  /** Pinned Firefox extension origin of the automatic pairing (POST /pair). */
  pairingPath: string;
  /** Extension origins accepted in `Origin`; `chrome-extension://*` style wildcards allowed. */
  allowedOrigins: string[];
}

/**
 * ID of the unpacked Chrome build, fixed by the `key` field of the extension manifest.
 * Firefox assigns a random UUID per install, so `moz-extension://*` stays a wildcard.
 */
export const CHROME_EXTENSION_ID = "pimhfahcdpnkbmflgggigkfdjolgemom";

function dataHome(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

function configHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number.parseInt(env.UI_ANNOTATE_PORT ?? "", 10);
  const extra = (env.UI_ANNOTATE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const tokenPath = env.UI_ANNOTATE_TOKEN_FILE ?? join(configHome(), "ui-annotate", "token");
  return {
    host: DEFAULT_HOST,
    port: Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT,
    dbPath: env.UI_ANNOTATE_DB ?? join(dataHome(), "ui-annotate", "db.sqlite"),
    tokenPath,
    pairingPath: join(dirname(tokenPath), "pairing.json"),
    allowedOrigins: [`chrome-extension://${CHROME_EXTENSION_ID}`, "moz-extension://*", ...extra],
  };
}

export const baseUrl = (config: Pick<Config, "host" | "port">) => `http://${config.host}:${config.port}`;

/** Reads the token, creating it with mode 0600 on first start. */
export function ensureToken(tokenPath: string): string {
  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, "utf8").trim();
    if (token.length >= 32) return token;
  }
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  return token;
}

export function readToken(tokenPath: string): string | null {
  if (!existsSync(tokenPath)) return null;
  const token = readFileSync(tokenPath, "utf8").trim();
  return token.length > 0 ? token : null;
}
