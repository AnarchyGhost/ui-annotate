import type { DispatchAgent } from "@ui-annotate/protocol";
import { browser } from "wxt/browser";

export interface OriginSettings {
  /** Inject the resolver at document_start and the overlay on every load of this origin. */
  alwaysOn: boolean;
  /** Absolute path of the project on disk; source paths are made relative to it. */
  projectRoot: string | null;
  /** Treat `#/route` as part of the page (hash routers). */
  includeHash: boolean;
  hideResolved: boolean;
  /** Every new annotation goes to a background run of `agent` in the project root. */
  autoDispatch: boolean;
  agent: DispatchAgent;
  /** Quiet period before the run; annotations left meanwhile go into the same run. */
  dispatchDelaySeconds: number;
}

export interface Settings {
  serverUrl: string;
  token: string;
  origins: Record<string, OriginSettings>;
}

export const DEFAULT_SERVER_URL = "http://127.0.0.1:4848";

export const DEFAULT_ORIGIN_SETTINGS: OriginSettings = {
  alwaysOn: false,
  projectRoot: null,
  includeHash: false,
  hideResolved: false,
  autoDispatch: false,
  agent: "claude",
  dispatchDelaySeconds: 5,
};

const KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  const stored = (await browser.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
  return {
    serverUrl: stored?.serverUrl || DEFAULT_SERVER_URL,
    token: stored?.token ?? "",
    origins: stored?.origins ?? {},
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await browser.storage.local.set({ [KEY]: next });
  return next;
}

export function originSettings(settings: Settings, origin: string): OriginSettings {
  return { ...DEFAULT_ORIGIN_SETTINGS, ...settings.origins[origin] };
}

export async function updateOrigin(origin: string, patch: Partial<OriginSettings>): Promise<OriginSettings> {
  const settings = await loadSettings();
  const next = { ...originSettings(settings, origin), ...patch };
  await saveSettings({ origins: { ...settings.origins, [origin]: next } });
  return next;
}

/** Loopback origins are covered by the static host permissions; others need an optional grant. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * Permission pattern for an origin. Permission match patterns cannot carry a port:
 * `http://127.0.0.1:4848` → `http://127.0.0.1/*`.
 */
export const permissionPattern = (origin: string) => {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
};

/**
 * Content-script match pattern for an always-on origin. Chrome accepts the port and matches the
 * exact dev server; Firefox rejects ports, so it matches the host and the overlay checks the
 * origin before mounting.
 */
export const registrationPattern = (origin: string, firefox: boolean) => (firefox ? permissionPattern(origin) : `${origin}/*`);

/** Match patterns that let the background reach the daemon and inject into local dev pages. */
export const LOCAL_HOST_PATTERNS = ["http://127.0.0.1/*", "http://localhost/*"];
