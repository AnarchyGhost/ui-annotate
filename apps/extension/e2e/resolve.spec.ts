import { normalizeSourcePath } from "@ui-annotate/protocol";
import { annotateElement, annotationsFor, clearSession, enableAlwaysOn, expect, fixture, test } from "./harness";

/**
 * Component and source location per framework, through the real extension.
 * Always-on registration puts the resolver at document_start, as for a configured origin.
 */
const FIXTURES = ["vue3", "vue3-inspector", "react18", "react19", "svelte4", "svelte5", "angular", "solid"];

for (const name of FIXTURES) {
  test(`resolves component and file:line on ${name}`, async ({ context, sw }) => {
    const expected = fixture(name);
    const origin = new URL(expected.url).origin;
    await clearSession(expected.url);
    await enableAlwaysOn(sw, origin, expected.root);

    const page = await context.newPage();
    await page.goto(expected.url);
    await expect(page.getByTestId("ua-toolbar")).toBeVisible();
    await expect(page.getByTestId("ua-status")).toHaveAttribute("data-state", "online");
    await page.getByTestId("ua-annotate").click();

    for (const target of expected.targets) {
      await annotateElement(page, target.selector, `check ${target.selector}`);
    }

    const annotations = await annotationsFor(expected.url);
    expect(annotations).toHaveLength(expected.targets.length);
    const actual = annotations.map((annotation) => {
      const source = annotation.targets[0]!.source;
      return {
        selector: annotation.targets[0]!.selector,
        framework: source.framework,
        componentName: source.componentName,
        file: source.file ? normalizeSourcePath(source.file, expected.root) : null,
        line: source.line,
      };
    });
    // uniqueSelector quotes attribute values: [data-testid=save] → [data-testid="save"].
    const canonical = expected.targets.map((target) => ({ ...target, selector: target.selector.replace(/=([\w-]+)\]/, '="$1"]') }));
    expect(actual).toEqual(canonical);
  });
}
