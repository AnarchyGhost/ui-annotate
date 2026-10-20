import {
  preactResolver,
  solidResolver,
  svelteResolver,
  vueResolver,
  type ElementSourceInfo,
  type FrameworkResolver,
} from "element-source";
import { resolveAngularStack } from "./angular.js";
import { readAttributeLocation } from "./attributes.js";
import { detectProductionFramework } from "./detect.js";
import { resolveReact } from "./react.js";
import type { AttributeLocation, Frame, Framework, ResolvedSource } from "./types.js";

interface RuntimeResult {
  framework: Framework;
  frames: Frame[];
  componentName: string | null;
}

const toFrame = (info: ElementSourceInfo): Frame => ({
  file: info.filePath,
  line: info.lineNumber,
  column: info.columnNumber,
  componentName: info.componentName,
});

const RUNTIME_RESOLVERS: Array<[Framework, FrameworkResolver]> = [
  ["vue", vueResolver],
  ["svelte", svelteResolver],
  ["solid", solidResolver],
  ["preact", preactResolver],
];

/** Svelte 4 dev meta carries `loc.char` and a 0-based line; Svelte 5 lines start at 1. */
function isSvelte4Meta(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    const meta: unknown = Reflect.get(current, "__svelte_meta");
    if (typeof meta === "object" && meta !== null) {
      const loc: unknown = Reflect.get(meta, "loc");
      return typeof loc === "object" && loc !== null && typeof Reflect.get(loc, "char") === "number";
    }
    current = current.parentElement;
  }
  return false;
}

async function resolveRuntime(element: Element): Promise<RuntimeResult | null> {
  const react = await resolveReact(element);
  if (react && (react.frames.length > 0 || react.componentName)) {
    return { framework: "react", frames: react.frames, componentName: react.componentName };
  }

  for (const [framework, resolver] of RUNTIME_RESOLVERS) {
    let frames = (await resolver.resolveStack(element)).map(toFrame).filter((frame) => frame.file.length > 0);
    if (frames.length === 0) continue;
    if (framework === "svelte" && isSvelte4Meta(element)) {
      frames = frames.map((frame) => ({ ...frame, line: frame.line === null ? null : frame.line + 1 }));
    }
    const componentName = frames.find((frame) => frame.componentName)?.componentName ?? null;
    return { framework, frames, componentName };
  }

  const angularFrames = resolveAngularStack(element);
  if (angularFrames.length > 0) {
    return {
      framework: "angular",
      frames: angularFrames.filter((frame) => frame.file.length > 0),
      componentName: angularFrames[0]?.componentName ?? null,
    };
  }
  return null;
}

const ATTRIBUTE_FRAMEWORK: Record<string, Framework> = {
  "data-v-inspector": "vue",
  "data-source-loc": "solid",
};

/** Single-file components are named after their file: `src/lib/InfoCard.svelte` → `InfoCard`. */
function nameFromFile(file: string | null): string | null {
  const match = file?.match(/([^/\\]+)\.(vue|svelte)$/);
  return match?.[1] ?? null;
}

function frameworkOf(attribute: AttributeLocation | null): Framework | null {
  return attribute ? (ATTRIBUTE_FRAMEWORK[attribute.attribute] ?? null) : null;
}

function empty(): ResolvedSource {
  return {
    framework: null,
    componentName: null,
    file: null,
    line: null,
    column: null,
    via: null,
    attribute: null,
    stack: [],
    reason: null,
  };
}

/**
 * Source location of a DOM element. A build-plugin attribute wins for file and line because it
 * points at the template; framework runtime data supplies the component and the parent chain.
 */
export async function resolveElement(element: Element): Promise<ResolvedSource> {
  const result = empty();
  const runtime = await resolveRuntime(element).catch(() => null);
  const attribute = readAttributeLocation(element);

  if (runtime) {
    const primary = runtime.frames[0];
    result.framework = runtime.framework;
    result.componentName = runtime.componentName;
    result.stack = runtime.frames;
    if (primary) {
      result.file = primary.file;
      result.line = primary.line;
      result.column = primary.column;
      result.via = "runtime";
    }
  }

  if (attribute) {
    result.file = attribute.file;
    result.line = attribute.line;
    result.column = attribute.column;
    result.via = "attribute";
    result.attribute = attribute.attribute;
    result.framework ??= frameworkOf(attribute);
  }

  result.componentName ??= nameFromFile(result.file);

  if (!result.file) {
    result.reason = detectProductionFramework(element) ? "production-build" : "no-framework";
    result.framework ??= detectProductionFramework(element);
  } else if (result.line === null) {
    result.reason = "no-line";
  }
  return result;
}
