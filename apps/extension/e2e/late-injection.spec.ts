import { annotateElement, annotationsFor, clearSession, expect, fixture, injectAndActivate, test } from "./harness";

/**
 * Injection after page load (icon click, no always-on registration). Fibers, Vue internals and
 * Svelte meta are plain DOM properties, so the source resolves without the document_start hook.
 */
const CASES = [
  { name: "react18", framework: "react", componentName: "AppToolbar", line: 6 },
  { name: "react19", framework: "react", componentName: "AppToolbar", line: 6 },
  { name: "vue3", framework: "vue", componentName: "AppToolbar", line: null },
  { name: "svelte5", framework: "svelte", componentName: "AppToolbar", line: 7 },
];

for (const expected of CASES) {
  test(`late injection resolves ${expected.name}`, async ({ context, sw }) => {
    const app = fixture(expected.name);
    await clearSession(app.url);
    const page = await context.newPage();
    await page.goto(app.url);
    await page.waitForSelector("[data-testid=save]");
    await injectAndActivate(sw, page);
    await annotateElement(page, "[data-testid=save]", "late");
    const [annotation] = await annotationsFor(app.url);
    const { framework, componentName, line } = annotation!.targets[0]!.source;
    expect({ framework, componentName, line }).toEqual({
      framework: expected.framework,
      componentName: expected.componentName,
      line: expected.line,
    });
  });
}
