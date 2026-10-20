/**
 * Accepts only events produced by the user agent. The page shares the DOM with the overlay and can
 * dispatch synthetic clicks and keys, or call `.click()` on buttons in the open shadow root; such
 * events have `isTrusted === false` and must not create, change or delete annotations.
 */
export function trusted<E extends Event>(handler: (event: E) => void): (event: E) => void {
  return (event) => {
    if (event.isTrusted) handler(event);
  };
}
