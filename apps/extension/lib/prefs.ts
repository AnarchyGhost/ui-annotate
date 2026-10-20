import { browser } from "wxt/browser";

/** Per-origin overlay preferences: theme, collapsed toolbar and its dragged position. */
export interface Prefs {
  theme: "auto" | "light" | "dark";
  collapsed: boolean;
  position: { x: number; y: number } | null;
}

const key = (origin: string) => `prefs:${origin}`;

export async function loadPrefs(origin: string): Promise<Prefs> {
  const stored = (await browser.storage.local.get(key(origin)))[key(origin)] as Partial<Prefs> | undefined;
  return {
    theme: stored?.theme ?? "auto",
    collapsed: stored?.collapsed ?? false,
    position: stored?.position ?? null,
  };
}

export async function savePrefs(origin: string, prefs: Prefs): Promise<void> {
  await browser.storage.local.set({ [key(origin)]: prefs });
}
