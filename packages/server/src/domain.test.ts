import { describe, expect, it } from "vitest";
import { deliveredTo, deliveryOf, resolveLiveTarget, withinRoot } from "./domain.js";

describe("resolveLiveTarget", () => {
  it("keeps a live bound session", () => {
    expect(resolveLiveTarget(10, [10, 20])).toEqual({ clientPid: 10, rebound: false });
  });

  it("moves to the only live session when the bound one is gone or unset", () => {
    expect(resolveLiveTarget(10, [20])).toEqual({ clientPid: 20, rebound: true });
    expect(resolveLiveTarget(null, [20])).toEqual({ clientPid: 20, rebound: true });
  });

  it("keeps the binding when the choice is ambiguous or nobody is live", () => {
    expect(resolveLiveTarget(10, [20, 30])).toEqual({ clientPid: 10, rebound: false });
    expect(resolveLiveTarget(10, [])).toEqual({ clientPid: 10, rebound: false });
    expect(resolveLiveTarget(null, [])).toEqual({ clientPid: null, rebound: false });
  });
});

describe("deliveredTo", () => {
  it("gives off annotations to everyone, session ones to their session, background ones to nobody", () => {
    expect(deliveredTo({ delivery: { mode: "off" } }, null)).toBe(true);
    expect(deliveredTo({ delivery: { mode: "session", clientPid: 10 } }, 10)).toBe(true);
    expect(deliveredTo({ delivery: { mode: "session", clientPid: 10 } }, 20)).toBe(false);
    expect(deliveredTo({ delivery: { mode: "session", clientPid: null } }, null)).toBe(false);
    expect(deliveredTo({ delivery: { mode: "background", agent: "claude", delaySeconds: 0 } }, 10)).toBe(false);
    // Hooks know the live sessions: a session not yet connected counts itself live.
    expect(deliveredTo({ delivery: { mode: "session", clientPid: null } }, 20, [])).toBe(true);
    expect(deliveredTo({ delivery: { mode: "session", clientPid: 10 } }, 20, [20])).toBe(true);
    expect(deliveredTo({ delivery: { mode: "session", clientPid: 10 } }, 20, [10])).toBe(false);
    expect(deliveredTo({ delivery: { mode: "session", clientPid: 10 } }, 20, [30])).toBe(false);
    expect(deliveredTo({ delivery: { mode: "session", clientPid: 10 } }, null, [])).toBe(false);
  });
});

describe("deliveryOf", () => {
  it("prefers `delivery` and maps the API level 4 `dispatch` to a background run", () => {
    expect(deliveryOf({ delivery: { mode: "session", clientPid: 5 }, dispatch: null })).toEqual({ mode: "session", clientPid: 5 });
    expect(deliveryOf({ delivery: null, dispatch: { agent: "codex", delaySeconds: 3 } })).toEqual({ mode: "background", agent: "codex", delaySeconds: 3 });
    expect(deliveryOf({ delivery: null, dispatch: null })).toEqual({ mode: "off" });
  });
});

describe("withinRoot", () => {
  it("matches the root and folders inside it only", () => {
    expect(withinRoot("/work/app", "/work/app/")).toBe(true);
    expect(withinRoot("/work/app/web", "/work/app")).toBe(true);
    expect(withinRoot("/work/apple", "/work/app")).toBe(false);
  });
});
