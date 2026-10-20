import { AnnotationInput, type ServerEvent } from "@ui-annotate/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clampWatchTimeout, waitForCreated } from "./api.js";
import { TransitionError, applyTransition } from "./domain.js";
import { NotFoundError, Store } from "./store.js";
import { annotationInput } from "./test-helpers.js";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());

const session = () => store.upsertSession({ url: "http://localhost:5173/settings?tab=1#x", title: "Settings", includeHash: false, projectRoot: null });

describe("sessions", () => {
  it("keys sessions by origin and pathname", () => {
    const first = session();
    const second = store.upsertSession({ url: "http://localhost:5173/settings?other", title: "S", includeHash: false, projectRoot: "/work/app" });
    expect(second.id).toBe(first.id);
    expect(second.projectRoot).toBe("/work/app");
    expect(store.upsertSession({ url: "http://localhost:5173/other", title: "", includeHash: false, projectRoot: null }).id).not.toBe(first.id);
  });

  it("includes the hash when asked", () => {
    const a = store.upsertSession({ url: "http://localhost:5173/#/a", title: "", includeHash: true, projectRoot: null });
    const b = store.upsertSession({ url: "http://localhost:5173/#/b", title: "", includeHash: true, projectRoot: null });
    expect(a.id).not.toBe(b.id);
  });

  it("counts open annotations per session", () => {
    const { id } = session();
    const first = store.createAnnotation(id, AnnotationInput.parse(annotationInput()));
    store.createAnnotation(id, AnnotationInput.parse(annotationInput()));
    store.transition(first.id, { action: "resolve", role: "agent", summary: "done" });
    expect(store.listSessions()[0]).toMatchObject({ id, pending: 1, total: 2 });
  });
});

describe("annotations", () => {
  it("numbers annotations per session and emits events", () => {
    const events: ServerEvent[] = [];
    store.on("event", (event) => events.push(event));
    const { id } = session();
    const a = store.createAnnotation(id, AnnotationInput.parse(annotationInput()));
    const b = store.createAnnotation(id, AnnotationInput.parse(annotationInput()));
    expect([a.number, b.number]).toEqual([1, 2]);
    expect(a.status).toBe("pending");
    expect(events.map((event) => event.type)).toEqual(["annotation.created", "annotation.created"]);
  });

  it("runs the agent workflow and records the thread", () => {
    const { id } = session();
    const created = store.createAnnotation(id, AnnotationInput.parse(annotationInput()));
    store.transition(created.id, { action: "acknowledge", role: "agent" });
    store.addMessage(created.id, "agent", "reply", "Which color?");
    store.addMessage(created.id, "user", "comment", "Blue");
    const resolved = store.transition(created.id, { action: "resolve", role: "agent", summary: "Aligned and recolored" });
    expect(resolved).toMatchObject({ status: "resolved", resolvedBy: "agent" });
    expect(resolved.thread.map((message) => `${message.role}:${message.kind}:${message.body}`)).toEqual([
      "agent:acknowledge:",
      "agent:reply:Which color?",
      "user:comment:Blue",
      "agent:resolve:Aligned and recolored",
    ]);
  });

  it("lets the user edit content and reopen through PATCH", () => {
    const { id } = session();
    const created = store.createAnnotation(id, AnnotationInput.parse(annotationInput()));
    store.transition(created.id, { action: "dismiss", role: "agent", reason: "out of scope" });
    const reopened = store.patchAnnotation(created.id, { status: "pending", comment: "Please do it", severity: "blocking" });
    expect(reopened).toMatchObject({ status: "pending", comment: "Please do it", severity: "blocking", resolvedBy: null });
    expect(reopened.thread.at(-1)).toMatchObject({ role: "user", kind: "reopen" });
  });

  it("renumbers later annotations after a delete", () => {
    const { id } = session();
    const [first, second, third] = [1, 2, 3].map(() => store.createAnnotation(id, AnnotationInput.parse(annotationInput())));
    store.deleteAnnotation(first!.id);
    expect(store.listAnnotations({ sessionId: id }).map((item) => [item.id, item.number])).toEqual([
      [second!.id, 1],
      [third!.id, 2],
    ]);
    expect(store.createAnnotation(id, AnnotationInput.parse(annotationInput())).number).toBe(3);
  });

  it("filters by status and deletes", () => {
    const { id } = session();
    const a = store.createAnnotation(id, AnnotationInput.parse(annotationInput()));
    store.createAnnotation(id, AnnotationInput.parse(annotationInput()));
    store.transition(a.id, { action: "resolve", role: "agent", summary: "ok" });
    expect(store.listAnnotations({ statuses: ["pending", "acknowledged"] })).toHaveLength(1);
    store.deleteAnnotation(a.id);
    expect(() => store.getAnnotation(a.id)).toThrow(NotFoundError);
  });
});

describe("transitions", () => {
  it.each([
    ["resolved", { action: "resolve", role: "agent", summary: "x" }],
    ["dismissed", { action: "dismiss", role: "agent", reason: "x" }],
    ["resolved", { action: "acknowledge", role: "agent" }],
    ["pending", { action: "reopen", role: "user" }],
  ] as const)("rejects from %s: %o", (status, transition) => {
    expect(() => applyTransition({ status }, transition)).toThrow(TransitionError);
  });

  it("acknowledge is idempotent", () => {
    expect(applyTransition({ status: "acknowledged" }, { action: "acknowledge", role: "agent" })).toEqual({
      status: "acknowledged",
      resolvedBy: null,
      message: null,
    });
  });
});

describe("waitForCreated", () => {
  afterEach(() => vi.useRealTimers());

  it("clamps the timeout to 25 s", () => {
    expect(clampWatchTimeout(60)).toBe(25);
    expect(clampWatchTimeout(0)).toBe(1);
    expect(clampWatchTimeout(Number.NaN)).toBe(25);
  });

  it("times out at 25 s even when asked for 60", async () => {
    vi.useFakeTimers();
    const result = waitForCreated(store, undefined, 60);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(24_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await expect(result).resolves.toBeNull();
  });

  it("returns a batch of annotations created close together", async () => {
    const { id } = session();
    const pending = waitForCreated(store, id, 5);
    store.createAnnotation(id, AnnotationInput.parse(annotationInput()));
    store.createAnnotation(id, AnnotationInput.parse(annotationInput()));
    const batch = await pending;
    expect(batch?.map((annotation) => annotation.number)).toEqual([1, 2]);
  });

  it("ignores other sessions", async () => {
    vi.useFakeTimers();
    const mine = session();
    const other = store.upsertSession({ url: "http://localhost:5173/other", title: "", includeHash: false, projectRoot: null });
    const pending = waitForCreated(store, mine.id, 2);
    store.createAnnotation(other.id, AnnotationInput.parse(annotationInput()));
    await vi.advanceTimersByTimeAsync(2_100);
    await expect(pending).resolves.toBeNull();
  });
});
