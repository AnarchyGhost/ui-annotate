import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Annotation } from "@ui-annotate/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentCommand, parseOutcomes, type AgentCommand } from "./dispatch.js";
import { annotationInput, startTestDaemon, type TestDaemon } from "./test-helpers.js";

/**
 * Fake agent: reads the prompt from stdin, logs start/end and the dispatch env to run.log in the
 * project, answers every id with the verdict from the comment ("say:QUESTION ...") or RESOLVED.
 */
const FAKE_AGENT = `
const { appendFileSync } = require("node:fs");
let prompt = "";
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", async () => {
  appendFileSync("run.log", "start " + process.env.UI_ANNOTATE_DISPATCH + "\\n");
  if (prompt.includes("say:SLOW")) await new Promise((resolve) => setTimeout(resolve, 400));
  if (prompt.includes("say:FAIL")) {
    console.error("boom");
    process.exit(1);
  }
  const blocks = prompt.split(/\\n---\\n/);
  const out = [];
  for (const block of blocks) {
    const id = block.match(/id=(a_[\\w-]+)/)?.[1];
    if (!id) continue;
    const verdict = block.match(/say:(QUESTION|DISMISSED)/)?.[1] ?? "RESOLVED";
    out.push("### " + id, verdict + ": handled " + id);
  }
  appendFileSync("run.log", "end\\n");
  console.log(out.join("\\n"));
});
`;

let t: TestDaemon;
let root: string;
let scriptDir: string;

beforeEach(async () => {
  scriptDir = mkdtempSync(join(tmpdir(), "ui-annotate-fake-"));
  const script = join(scriptDir, "agent.cjs");
  writeFileSync(script, FAKE_AGENT);
  root = mkdtempSync(join(tmpdir(), "ui-annotate-root-"));
  t = await startTestDaemon({ command: (_agent, prompt): AgentCommand => ({ command: process.execPath, args: [script], stdin: prompt, outputFile: null }) });
});

afterEach(async () => {
  await t.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(scriptDir, { recursive: true, force: true });
});

async function session(projectRoot: string | null = root) {
  const response = await t.call("/sessions", { method: "POST", json: { url: "http://localhost:5173/settings", title: "Settings", projectRoot } });
  return ((await response.json()) as { id: string }).id;
}

async function annotate(sessionId: string, comment: string, delaySeconds = 0, dispatch = true) {
  const response = await t.call(`/sessions/${sessionId}/annotations`, {
    method: "POST",
    json: annotationInput({ comment, ...(dispatch ? { dispatch: { agent: "claude", delaySeconds } } : {}) }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Annotation;
}

const fetchAnnotation = async (id: string) => (await (await t.call(`/annotations/${id}`)).json()) as Annotation;
const runLog = () => {
  try {
    return readFileSync(join(root, "run.log"), "utf8").trim().split("\n");
  } catch {
    return [];
  }
};

describe("automatic mode", () => {
  it("runs the agent in the project root and resolves with its summary", async () => {
    const created = await annotate(await session(), "Rename Save to Store");
    await t.daemon.dispatcher.idle();
    const annotation = await fetchAnnotation(created.id);
    expect(annotation).toMatchObject({ status: "resolved", resolvedBy: "agent" });
    expect(annotation.thread.map((message) => [message.kind, message.body])).toEqual([
      ["acknowledge", ""],
      ["reply", "Automatic mode: claude is working on it in the background."],
      ["resolve", `handled ${created.id}`],
    ]);
    // cwd is the project root; the hooks see the dispatch flag.
    expect(runLog()).toEqual(["start 1", "end"]);
  });

  it("collects annotations of the delay into one run", async () => {
    const sessionId = await session();
    const first = await annotate(sessionId, "first", 1);
    const second = await annotate(sessionId, "second", 1);
    await t.daemon.dispatcher.idle();
    expect(runLog()).toEqual(["start 1", "end"]);
    expect((await fetchAnnotation(first.id)).status).toBe("resolved");
    expect((await fetchAnnotation(second.id)).status).toBe("resolved");
  });

  it("runs one agent per project at a time", async () => {
    const sessionId = await session();
    await annotate(sessionId, "say:SLOW first");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await annotate(sessionId, "second");
    await t.daemon.dispatcher.idle();
    expect(runLog()).toEqual(["start 1", "end", "start 1", "end"]);
    expect((await fetchAnnotation(second.id)).status).toBe("resolved");
  });

  it("turns QUESTION into a reply and DISMISSED into dismiss", async () => {
    const sessionId = await session();
    const question = await annotate(sessionId, "say:QUESTION which label?", 1);
    const dismissed = await annotate(sessionId, "say:DISMISSED not needed", 1);
    await t.daemon.dispatcher.idle();
    const asked = await fetchAnnotation(question.id);
    expect(asked.status).toBe("acknowledged");
    expect(asked.thread.at(-1)).toMatchObject({ role: "agent", kind: "reply", body: `handled ${question.id}` });
    expect(await fetchAnnotation(dismissed.id)).toMatchObject({ status: "dismissed", resolvedBy: "agent" });
  });

  it("reports a failed run in the thread and keeps the annotation open", async () => {
    const created = await annotate(await session(), "say:FAIL");
    await t.daemon.dispatcher.idle();
    const annotation = await fetchAnnotation(created.id);
    expect(annotation.status).toBe("acknowledged");
    expect(annotation.thread.at(-1)?.body).toBe("Automatic mode: claude run failed, exit code 1: boom");
  });

  it("starts nothing without a project root and says so", async () => {
    const created = await annotate(await session(null), "no root");
    await t.daemon.dispatcher.idle();
    const annotation = await fetchAnnotation(created.id);
    expect(annotation.status).toBe("pending");
    expect(annotation.thread[0]?.body).toMatch(/^Automatic mode: no project root/);
    expect(runLog()).toEqual([]);
  });

  it("leaves annotations without dispatch to the user's agents", async () => {
    const created = await annotate(await session(), "manual", 0, false);
    await t.daemon.dispatcher.idle();
    expect((await fetchAnnotation(created.id)).status).toBe("pending");
    expect(runLog()).toEqual([]);
  });

  it("skips annotations the user closed during the delay", async () => {
    const created = await annotate(await session(), "closed", 1);
    await t.call(`/annotations/${created.id}`, { method: "PATCH", json: { status: "dismissed" } });
    await t.daemon.dispatcher.idle();
    expect(runLog()).toEqual([]);
  });
});

describe("agent commands", () => {
  it("limits every agent to reading and editing", () => {
    const claude = agentCommand("claude", "prompt", "/work/app", "/tmp/x");
    expect(claude.args).toEqual(["-p", "--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write,Glob,Grep", "--output-format", "text"]);
    expect(claude.stdin).toBe("prompt");
    const codex = agentCommand("codex", "prompt", "/work/app", "/tmp/x");
    expect(codex.args).toEqual(["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", "/work/app", "-o", "/tmp/x/last-message.txt", "-"]);
    expect(codex.outputFile).toBe("/tmp/x/last-message.txt");
    const cursor = agentCommand("cursor", "prompt", "/work/app", "/tmp/x");
    expect(cursor.command).toBe("cursor-agent");
    expect(cursor.args).toEqual(["-p", "--force", "--sandbox", "enabled", "--trust", "--workspace", "/work/app", "--output-format", "text", "prompt"]);
  });

  it("parses verdicts per id and ignores unknown or empty sections", () => {
    const output = "Done.\n\n### a_one\nRESOLVED: renamed the label\n\n## a_two\nQUESTION: which one?\n\n### a_three\nRESOLVED:\n\n### a_other\nRESOLVED: x";
    const outcomes = parseOutcomes(output, ["a_one", "a_two", "a_three"]);
    expect([...outcomes]).toEqual([
      ["a_one", { kind: "resolved", text: "renamed the label" }],
      ["a_two", { kind: "question", text: "which one?" }],
    ]);
  });
});
