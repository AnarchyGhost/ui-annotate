import { describe, expect, it } from "vitest";
import { checkAccess } from "./security.js";

const policy = {
  port: 4848,
  token: "t".repeat(43),
  allowedOrigins: ["chrome-extension://pimhfahcdpnkbmflgggigkfdjolgemom", "moz-extension://*"],
};
const auth = { authorization: `Bearer ${policy.token}` };

describe("checkAccess", () => {
  it.each([
    ["Chrome extension POST", { host: "127.0.0.1:4848", origin: "chrome-extension://pimhfahcdpnkbmflgggigkfdjolgemom", "sec-fetch-site": "none", ...auth }],
    ["Chrome extension GET", { host: "127.0.0.1:4848", "sec-fetch-site": "none", ...auth }],
    ["Firefox extension GET", { host: "localhost:4848", "sec-fetch-site": "same-origin", ...auth }],
    ["Firefox extension POST", { host: "127.0.0.1:4848", origin: "moz-extension://5b0c7c0e-0000-4000-8000-000000000000", ...auth }],
    ["CLI client", { host: "127.0.0.1:4848", ...auth }],
  ])("accepts %s", (_name, headers) => {
    expect(checkAccess(headers, policy, true)).toBeNull();
  });

  it.each([
    ["foreign Host (DNS rebinding)", { host: "evil.example:4848", ...auth }, 403],
    ["other port in Host", { host: "127.0.0.1:5173", ...auth }, 403],
    ["web page Origin", { host: "127.0.0.1:4848", origin: "http://localhost:5173", ...auth }, 403],
    ["opaque Origin", { host: "127.0.0.1:4848", origin: "null", ...auth }, 403],
    ["other Chrome extension", { host: "127.0.0.1:4848", origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ...auth }, 403],
    ["no-cors page GET", { host: "127.0.0.1:4848", "sec-fetch-site": "cross-site", ...auth }, 403],
    ["same-site page GET", { host: "127.0.0.1:4848", "sec-fetch-site": "same-site", ...auth }, 403],
    ["missing token", { host: "127.0.0.1:4848" }, 401],
    ["wrong token", { host: "127.0.0.1:4848", authorization: "Bearer nope" }, 401],
    ["token without Bearer", { host: "127.0.0.1:4848", authorization: policy.token }, 401],
  ])("rejects %s", (_name, headers, status) => {
    expect(checkAccess(headers, policy, true)?.status).toBe(status);
  });

  it("skips the token for public routes but keeps Host and Origin checks", () => {
    expect(checkAccess({ host: "127.0.0.1:4848" }, policy, false)).toBeNull();
    expect(checkAccess({ host: "127.0.0.1:4848", origin: "https://evil.example" }, policy, false)?.status).toBe(403);
  });
});
