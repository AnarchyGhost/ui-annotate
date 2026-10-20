import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export interface AccessPolicy {
  port: number;
  token: string;
  allowedOrigins: string[];
}

export interface Rejection {
  status: 401 | 403;
  error: string;
}

function originAllowed(origin: string, allowed: string[]): boolean {
  return allowed.some((pattern) => (pattern.endsWith("*") ? origin.startsWith(pattern.slice(0, -1)) : origin === pattern));
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  if (!match?.[1]) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Checks every request in this order:
 * 1. `Host` is the loopback name and port: blocks DNS rebinding.
 * 2. `Origin`, when present, is an extension origin from the allowlist: blocks web pages.
 *    Without `Origin`, `Sec-Fetch-Site` must be absent (CLI clients), `none` (Chrome extension GET)
 *    or `same-origin` (Firefox extension GET); pages send `cross-site` / `same-site`.
 * 3. `Authorization: Bearer <token>` unless the route is public.
 * Background requests of the extension (checked in Chrome 151–155 and Firefox 158): GET without
 * `Origin`; POST/PATCH with the extension `Origin`; `Sec-Fetch-Site` `none` in Chrome, `same-origin`
 * in Firefox.
 */
export function checkAccess(headers: IncomingHttpHeaders, policy: AccessPolicy, requireToken: boolean): Rejection | null {
  const host = headers.host ?? "";
  if (host !== `127.0.0.1:${policy.port}` && host !== `localhost:${policy.port}`) {
    return { status: 403, error: "host not allowed" };
  }
  const origin = headers.origin;
  if (origin !== undefined) {
    if (!originAllowed(origin, policy.allowedOrigins)) return { status: 403, error: "origin not allowed" };
  } else {
    const site = headers["sec-fetch-site"];
    if (site !== undefined && site !== "none" && site !== "same-origin") {
      return { status: 403, error: "cross-site request without origin" };
    }
  }
  if (requireToken && !tokenMatches(headers.authorization, policy.token)) {
    return { status: 401, error: "missing or invalid token" };
  }
  return null;
}
