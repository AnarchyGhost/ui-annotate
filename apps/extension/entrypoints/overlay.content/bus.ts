import type { OverlayAction, OverlaySnapshot } from "../../lib/messages";

/** activate: show and annotate; show: show only; an action: a shortcut command. */
export type OverlayCommand = "activate" | "show" | { action: OverlayAction };

/** Commands from the background that may arrive before the Vue app mounts; they are queued. */
export interface OverlayBus {
  emit(command: OverlayCommand): void;
  listen(handler: (command: OverlayCommand) => void): void;
  /** Resolves on the first command: the user asked for the overlay on this page. */
  firstCommand: Promise<void>;
  /** The mounted app reports its state through this; the popup asks for it. */
  provide(snapshot: () => OverlaySnapshot): void;
  snapshot(): OverlaySnapshot | null;
}

export function createOverlayBus(): OverlayBus {
  const queue: OverlayCommand[] = [];
  let handler: ((command: OverlayCommand) => void) | null = null;
  let provider: (() => OverlaySnapshot) | null = null;
  let commanded!: () => void;
  const firstCommand = new Promise<void>((resolve) => (commanded = resolve));
  return {
    provide(next) {
      provider = next;
    },
    snapshot() {
      return provider ? provider() : null;
    },
    emit(command) {
      commanded();
      if (handler) handler(command);
      else queue.push(command);
    },
    listen(next) {
      handler = next;
      for (const command of queue.splice(0)) next(command);
    },
    firstCommand,
  };
}
