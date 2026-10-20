import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

/**
 * Dev servers serve transformed modules with an inline or linked source map. Positions captured
 * at runtime (React 19 `_debugStack`) or baked into the transformed code (React 18 `__source`
 * after a Babel pass that prepends code) refer to the transformed module and are mapped back here.
 */
interface LoadedModule {
  code: string;
  map: TraceMap | null;
}

export interface MappedPosition {
  file: string;
  line: number;
  column: number | null;
}

const modules = new Map<string, Promise<LoadedModule | null>>();

const INLINE_MAP = /\/\/[#@] sourceMappingURL=data:application\/json;(?:charset=[\w-]+;)?base64,([A-Za-z0-9+/=]+)\s*$/;
const LINKED_MAP = /\/\/[#@] sourceMappingURL=(\S+)\s*$/;

function decodeBase64Utf8(data: string): string {
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function readMap(code: string, moduleUrl: string): Promise<TraceMap | null> {
  const inline = code.match(INLINE_MAP);
  if (inline?.[1]) return new TraceMap(decodeBase64Utf8(inline[1]), moduleUrl);
  const linked = code.match(LINKED_MAP);
  if (!linked?.[1]) return null;
  const mapUrl = new URL(linked[1], moduleUrl).href;
  const response = await fetch(mapUrl);
  return response.ok ? new TraceMap(await response.text(), mapUrl) : null;
}

export function loadModule(url: string): Promise<LoadedModule | null> {
  let pending = modules.get(url);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(url);
      if (!response.ok) return null;
      const code = await response.text();
      return { code, map: await readMap(code, url).catch(() => null) };
    })().catch(() => null);
    modules.set(url, pending);
    // A failed fetch (dev server restarting) is retried on the next lookup.
    void pending.then((loaded) => {
      if (!loaded) modules.delete(url);
    });
  }
  return pending;
}

/** `column` is 1-based on input and output, as in stack traces and editors. */
export async function mapPosition(url: string, line: number, column: number): Promise<MappedPosition | null> {
  const loaded = await loadModule(url);
  if (!loaded?.map) return null;
  const original = originalPositionFor(loaded.map, { line, column: Math.max(0, column - 1) });
  if (original.source === null || original.line === null) return null;
  return { file: original.source, line: original.line, column: original.column === null ? null : original.column + 1 };
}

/**
 * URL of the loaded module that serves `filePath`: the resource whose path is the longest suffix
 * match. Vite serves `/src/App.tsx` for `<root>/src/App.tsx` and `/@fs/<abs>` outside the root.
 */
export function moduleUrlForFile(filePath: string): string | null {
  let best: { url: string; score: number } | null = null;
  for (const entry of performance.getEntriesByType("resource")) {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(entry.name).pathname).replace(/^\/@fs/, "");
    } catch {
      continue;
    }
    if (pathname.length < 2 || !filePath.endsWith(pathname)) continue;
    if (!best || pathname.length > best.score) best = { url: entry.name, score: pathname.length };
  }
  return best?.url ?? null;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Original line of a JSX element whose `__source` object says `{ lineNumber, columnNumber }`.
 * The object literal sits in the transformed module; its own generated position maps back to
 * the JSX element. Returns null when the module does not contain exactly one such object.
 */
export async function mapSourceObject(
  url: string,
  lineNumber: number,
  columnNumber: number | null,
): Promise<MappedPosition | null> {
  const loaded = await loadModule(url);
  if (!loaded?.map) return null;
  const column = columnNumber === null ? "\\d+" : String(columnNumber);
  const pattern = new RegExp(`lineNumber:\\s*${lineNumber},\\s*columnNumber:\\s*${escapeRegExp(column)}\\b`, "g");
  const matches = [...loaded.code.matchAll(pattern)];
  if (matches.length !== 1 || matches[0]?.index === undefined) return null;
  const before = loaded.code.slice(0, matches[0].index);
  const generatedLine = before.split("\n").length;
  const generatedColumn = matches[0].index - before.lastIndexOf("\n");
  const original = originalPositionFor(loaded.map, { line: generatedLine, column: generatedColumn - 1 });
  if (original.source === null || original.line === null) return null;
  return { file: original.source, line: original.line, column: original.column === null ? null : original.column + 1 };
}
