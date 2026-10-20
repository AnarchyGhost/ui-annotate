---
name: ui-annotate
description: Work through UI annotations the user left in the browser with the ui-annotate extension. Use when the context mentions pending ui-annotate annotations, a <channel source="ui-annotate"> message arrives, or the user asks to handle browser feedback.
---

# Handling ui-annotate feedback

Each annotation points at a DOM element of the running app. The first line of every annotation
block is the source location and the component, for example
`` `src/components/AppToolbar.vue:8:5` `<AppToolbar>` — #1 fix/blocking [pending] id=a_x1y2 ``.

## Workflow

0. When you start a dev server of this project (or the user names its address), call
   `link_page(url)` with that address. It ties the page to this repository: paths in annotations
   become relative to it and its annotations reach this session. Usually the server finds the root
   itself; linking makes it certain (needed behind a proxy or in a container).
1. Call `get_pending` (all pages) or `get_pending(sessionId)` for one page.
2. For each annotation, in order of severity (blocking → important → minor):
   1. `acknowledge(id)`, so the user sees the work started.
   2. Open the file at the given line first; no grep needed. Without a line (`source note: no-line`),
      the file is still right: find the element by `selector`, `text` and `path` inside that file.
      With `source unknown`, search the code base for the element text and classes.
   3. Make the change the comment asks for. `intent` tells what kind: `fix` a bug, `change` a design
      decision, `question` needs an answer, `approve` needs no code change.
   4. `resolve(id, summary)` with one or two sentences on what changed. The user reads this in the browser.
3. When the request is unclear, `reply(id, question)` and continue with other annotations; the user
   answers in the overlay and `get_annotation(id)` shows the thread.
4. When the request should not be done, `dismiss(id, reason)`.

## Rules

- Never resolve an annotation without a change or an answer the user asked for.
- Several targets (`target 1:`, `target 2:`) belong to one request; handle them together.
- `selected text` quotes what the user highlighted; it usually names the exact string to change.
- Paths are relative to the project root. A path that does not exist means the page belongs to
  another project: `reply` so the user can check the project root in the extension popup.
- `watch_annotations` waits up to 25 s for new annotations; use it only when the user asked you to
  keep watching.
