/**
 * Brings file paths from framework internals and build-plugin attributes to a path relative
 * to the project root. Sources differ: Vue `__file` and code-inspector give absolute paths,
 * React 19 stacks give dev-server URLs, Svelte, Angular and most attributes give relative ones.
 */
export function normalizeSourcePath(raw: string, projectRoot: string | null = null): string {
  let path = raw.trim();
  let fromUrl = false;

  path = path.replace(/^webpack-internal:\/\/\/(\([^)]*\)\/)?/, "").replace(/^webpack:\/\/[^/]*\//, "");

  if (/^https?:\/\//.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
      fromUrl = true;
    } catch {
      return raw;
    }
  } else if (path.startsWith("file://")) {
    path = decodeURIComponent(path.slice("file://".length));
  }

  path = path.replace(/[?#].*$/, "");

  if (path.startsWith("/@fs/")) {
    path = path.slice("/@fs".length);
    fromUrl = false;
  }

  const root = projectRoot ? projectRoot.replace(/\/+$/, "") : null;
  if (root && (path === root || path.startsWith(`${root}/`))) {
    return path.slice(root.length + 1);
  }

  if (fromUrl) path = path.replace(/^\/+/, "");
  return path.replace(/^\.\//, "");
}

/**
 * Path the agent may open: relative to the project root and staying inside it. Absolute paths
 * outside the root and `..` segments are refused (null): the value comes from the page, which
 * could otherwise point the agent at `~/.ssh/id_rsa` with "open this file".
 */
export function projectRelativePath(raw: string, projectRoot: string | null): string | null {
  const path = normalizeSourcePath(raw, projectRoot);
  if (path.length === 0) return null;
  if (/^(\/|\\|~|[A-Za-z]:[\\/])/.test(path)) return null;
  if (path.split(/[\\/]/).includes("..")) return null;
  return path;
}
