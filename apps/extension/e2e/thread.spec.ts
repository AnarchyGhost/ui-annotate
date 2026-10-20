import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { E2E_DIR, E2E_PORT } from "../playwright.config";
import { annotateElement, annotationsFor, clearSession, expect, fixture, injectAndActivate, test } from "./harness";

/** Agent replies and resolves through MCP; the overlay shows the thread live. */
const app = fixture("vue3");
const CLI = fileURLToPath(new URL("../../../packages/server/dist/cli.js", import.meta.url));

async function mcpClient(): Promise<Client> {
  const client = new Client({ name: "e2e-agent", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "mcp"],
      cwd: app.root,
      env: {
        ...(process.env as Record<string, string>),
        UI_ANNOTATE_PORT: String(E2E_PORT),
        UI_ANNOTATE_DB: join(E2E_DIR, "db.sqlite"),
        UI_ANNOTATE_TOKEN_FILE: join(E2E_DIR, "token"),
      },
    }),
  );
  return client;
}

const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0]!.text;

test("agent reply and resolve appear in the overlay; resolved markers hide on demand", async ({ context, sw }) => {
  await clearSession(app.url);
  const page = await context.newPage();
  await page.goto(app.url);
  await page.waitForSelector("[data-testid=save]");
  await injectAndActivate(sw, page);
  await annotateElement(page, "[data-testid=save]", "Make it green");
  await annotateElement(page, "[data-testid=card-text]", "Second one");
  const [first] = await annotationsFor(app.url);

  const agent = await mcpClient();
  try {
    const pending = text(await agent.callTool({ name: "get_pending", arguments: {} }));
    expect(pending).toContain("`src/components/AppToolbar.vue` `<AppToolbar>`");

    await agent.callTool({ name: "acknowledge", arguments: { id: first!.id } });
    await expect(page.getByTestId("ua-marker-1")).toHaveAttribute("data-status", "acknowledged");

    await agent.callTool({ name: "reply", arguments: { id: first!.id, message: "Which shade of green?" } });
    await page.getByTestId("ua-marker-1").click();
    const thread = page.getByTestId("ua-thread");
    await expect(thread).toContainText("Which shade of green?");
    await expect(thread.locator('[data-role="agent"][data-kind="reply"]')).toHaveCount(1);

    // The user answers in the overlay; the agent reads it back.
    await page.getByTestId("ua-reply").fill("#16a34a");
    await page.getByTestId("ua-reply").press("Enter");
    await expect(thread.locator('[data-role="user"][data-kind="comment"]')).toHaveText(/#16a34a/);
    expect(text(await agent.callTool({ name: "get_annotation", arguments: { id: first!.id } }))).toContain("user/comment: #16a34a");

    await agent.callTool({ name: "resolve", arguments: { id: first!.id, summary: "Button uses #16a34a now" } });
    await expect(page.getByTestId("ua-card-status")).toHaveText("resolved");
    await expect(thread.locator('[data-kind="resolve"]')).toContainText("Button uses #16a34a now");
    await expect(page.getByTestId("ua-marker-1")).toHaveAttribute("data-status", "resolved");
    await expect(page.getByTestId("ua-count")).toHaveText("1");

    await page.keyboard.press("Escape");
    await page.getByTestId("ua-hide-resolved").click();
    await expect(page.getByTestId("ua-marker-1")).toHaveCount(0);
    await expect(page.getByTestId("ua-marker-2")).toBeVisible();
    await page.getByTestId("ua-hide-resolved").click();
    await expect(page.getByTestId("ua-marker-1")).toBeVisible();

    const [stored] = await annotationsFor(app.url);
    expect(stored).toMatchObject({ status: "resolved", resolvedBy: "agent" });
  } finally {
    await agent.close();
  }
});
