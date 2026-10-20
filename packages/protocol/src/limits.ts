/** String and collection limits shared by the extension, the resolver bridge and the server. */
export const LIMITS = {
  comment: 4000,
  threadMessage: 8000,
  selectedText: 500,
  nearbyText: 300,
  element: 200,
  selector: 1000,
  elementPath: 600,
  filePath: 1000,
  componentName: 200,
  styleValue: 200,
  styleEntries: 40,
  ariaEntries: 20,
  stackFrames: 8,
  targets: 20,
  url: 2000,
  title: 300,
  reason: 500,
} as const;

/** additionalContext limit of Claude Code hooks; digest must fit under it. */
export const HOOK_CONTEXT_LIMIT = 10_000;

/** Upper bound of watch_annotations long-poll: Cursor drops tool calls after ~30 s. */
export const WATCH_TIMEOUT_MAX_SECONDS = 25;

export const DEFAULT_PORT = 4848;
export const DEFAULT_HOST = "127.0.0.1";
