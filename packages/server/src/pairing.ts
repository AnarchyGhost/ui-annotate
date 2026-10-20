import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CHROME_EXTENSION_ID } from "./config.js";

/**
 * Automatic hand-over of the token to the extension (POST /pair), so nobody pastes it.
 * The browser sets `Origin`; a page cannot forge it, another extension has another origin.
 * - Chrome: the ID is fixed by the manifest key, the origin is compared exactly.
 * - Firefox: the UUID is random per install. The first moz-extension origin that pairs is pinned
 *   (trust on first use); others are refused until `ui-annotate unpair`.
 */
export type PairDecision = { ok: true; pinFirefox: string | null } | { ok: false; error: string };

const CHROME_ORIGIN = `chrome-extension://${CHROME_EXTENSION_ID}`;
const FIREFOX_ORIGIN = /^moz-extension:\/\/[0-9a-f-]{36}$/;

export function decidePairing(origin: string | undefined, pinnedFirefox: string | null): PairDecision {
  if (origin === CHROME_ORIGIN) return { ok: true, pinFirefox: null };
  if (origin && FIREFOX_ORIGIN.test(origin)) {
    if (pinnedFirefox === null) return { ok: true, pinFirefox: origin };
    if (pinnedFirefox === origin) return { ok: true, pinFirefox: null };
    return { ok: false, error: "another Firefox extension install is paired; run `ui-annotate unpair` to reset" };
  }
  return { ok: false, error: "pairing is open to the ui-annotate extension only" };
}

interface PairingFile {
  firefox: string | null;
}

export function readPairing(path: string): PairingFile {
  if (!existsSync(path)) return { firefox: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PairingFile>;
    return { firefox: typeof parsed.firefox === "string" ? parsed.firefox : null };
  } catch {
    return { firefox: null };
  }
}

export function writePairing(path: string, pairing: PairingFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(pairing, null, 2)}\n`, { mode: 0o600 });
}
