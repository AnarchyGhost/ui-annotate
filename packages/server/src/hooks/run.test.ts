import { AnnotationInput, HOOK_CONTEXT_LIMIT, type Annotation, type Session } from "@ui-annotate/protocol";
import { describe, expect, it } from "vitest";
import { annotationInput } from "../test-helpers.js";
import { buildHookOutput, scopeToProject, type ScopedAnnotations } from "./run.js";

function annotation(id: string, sessionId = "s1", comment = "Fix it"): Annotation {
  const input = AnnotationInput.parse(annotationInput({ comment }));
  return {
    ...input,
    id,
    sessionId,
    number: 1,
    status: "pending",
    resolvedBy: null,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    thread: [],
  };
}

const mine = (project: Annotation[], unscoped = 0): ScopedAnnotations => ({ project, unscoped });
const none = mine([]);

// Stdin payloads as the clients send them (Claude Code hooks reference).
const claudeSessionStart = { hook_event_name: "SessionStart", source: "startup", cwd: "/work/app" };
const claudePrompt = { hook_event_name: "UserPromptSubmit", prompt: "go", cwd: "/work/app" };
const claudeStop = { hook_event_name: "Stop", stop_hook_active: false, cwd: "/work/app" };
const claudeStopActive = { hook_event_name: "Stop", stop_hook_active: true, cwd: "/work/app" };

describe("Claude Code hooks", () => {
  it("stay silent with no open annotations", () => {
    for (const [event, input] of [["SessionStart", claudeSessionStart], ["UserPromptSubmit", claudePrompt], ["Stop", claudeStop]] as const) {
      expect(buildHookOutput("claude", event, input, none).stdout).toBeNull();
    }
  });

  it("inject a digest on SessionStart and UserPromptSubmit", () => {
    const open = mine([annotation("a_1")]);
    expect(buildHookOutput("claude", "SessionStart", claudeSessionStart, open).stdout).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: expect.stringContaining("AppToolbar.vue:8:5") },
    });
    const prompt = buildHookOutput("claude", "UserPromptSubmit", claudePrompt, open).stdout as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(prompt.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(prompt.hookSpecificOutput.additionalContext).toContain("id=a_1");
  });

  it("keep the digest under the additionalContext limit, unscoped line included", () => {
    const open = mine(
      Array.from({ length: 100 }, (_, index) => annotation(`a_${index}`, "s1", "x".repeat(400))),
      7,
    );
    const output = buildHookOutput("claude", "UserPromptSubmit", claudePrompt, open).stdout as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(output.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(HOOK_CONTEXT_LIMIT);
    expect(output.hookSpecificOutput.additionalContext).toContain("7 open annotation(s) from pages without a project root");
  });

  it("block Stop while annotations are open and respect stop_hook_active", () => {
    const open = mine([annotation("a_1")]);
    expect(buildHookOutput("claude", "Stop", claudeStop, open).stdout).toEqual({ decision: "block", reason: expect.stringContaining("1 open") });
    expect(buildHookOutput("claude", "Stop", claudeStopActive, open).stdout).toBeNull();
  });

  it("only count annotations of pages without a project root, and never block Stop for them", () => {
    const unscoped = mine([], 2);
    const start = buildHookOutput("claude", "SessionStart", claudeSessionStart, unscoped).stdout as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(start.hookSpecificOutput.additionalContext).toMatch(/^ui-annotate: 2 open annotation\(s\) from pages without a project root/);
    expect(start.hookSpecificOutput.additionalContext).not.toContain("AppToolbar");
    expect(buildHookOutput("claude", "Stop", claudeStop, unscoped).stdout).toBeNull();
  });
});

describe("Codex and Cursor hooks", () => {
  it("Codex uses the same shapes as Claude Code", () => {
    const open = mine([annotation("a_1")]);
    expect(buildHookOutput("codex", "SessionStart", claudeSessionStart, open).stdout).toHaveProperty("hookSpecificOutput.additionalContext");
    expect(buildHookOutput("codex", "Stop", { stop_hook_active: false }, open).stdout).toMatchObject({ decision: "block" });
  });

  it("Cursor gets additional_context on sessionStart and a bounded followup on stop", () => {
    const open = mine([annotation("a_1")]);
    expect(buildHookOutput("cursor", "sessionStart", {}, open).stdout).toEqual({ additional_context: expect.any(String) });
    expect(buildHookOutput("cursor", "stop", { status: "completed", loop_count: 0 }, open).stdout).toEqual({ followup_message: expect.any(String) });
    expect(buildHookOutput("cursor", "stop", { status: "completed", loop_count: 2 }, open).stdout).toBeNull();
    expect(buildHookOutput("cursor", "stop", { status: "aborted", loop_count: 0 }, open).stdout).toBeNull();
    expect(buildHookOutput("cursor", "beforeSubmitPrompt", {}, open).stdout).toBeNull();
  });
});

describe("scopeToProject", () => {
  const session = (id: string, projectRoot: string | null) =>
    ({ id, projectRoot, projectRootSource: projectRoot ? "manual" : null, origin: "", pathname: "", url: "", title: "", createdAt: "", updatedAt: "" }) satisfies Session;

  it("keeps this project, counts pages without a root, drops other projects", () => {
    const sessions = new Map([
      ["mine", session("mine", "/work/app")],
      ["other", session("other", "/work/other")],
      ["prefix", session("prefix", "/work/ap")],
      ["unknown", session("unknown", null)],
    ]);
    const open = [annotation("a", "mine"), annotation("b", "other"), annotation("c", "unknown"), annotation("d", "prefix")];
    const scoped = scopeToProject(open, sessions, "/work/app/packages/web");
    expect(scoped.project.map((item) => item.id)).toEqual(["a"]);
    expect(scoped.unscoped).toBe(1);
  });
});
