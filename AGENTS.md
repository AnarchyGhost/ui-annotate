# AGENTS.md

Guide for coding agents (and humans) changing ui-annotate. Installing it for a user is covered in
[docs/agents/install.md](docs/agents/install.md). The product overview is in [README.md](README.md).

## Layout

pnpm workspace, TypeScript (strict, `noUncheckedIndexedAccess`), ESM everywhere.

| Path | What | Build |
|---|---|---|
| `packages/protocol` | zod schemas of everything on the wire, limits, markdown formatters, path normalization | tsup |
| `packages/resolver` | MAIN-world bundle: framework detection, component and `file:line` per element, source maps | tsup |
| `packages/server` | npm package `ui-annotate`: daemon (HTTP + SSE + SQLite), MCP server, hooks, dispatcher of Background agent mode, live sessions, CLI | tsup |
| `packages/claude-plugin` | Claude Code plugin: `.mcp.json`, hooks, skill, `bin/ui-annotate` launcher, bundled `dist/cli.js` | tsup |
| `apps/extension` | WXT + Vue 3 extension: background, overlay content script (shadow root), popup | wxt |
| `fixtures/*` | dev apps per framework with `expected.json`, used by e2e | Vite / Angular CLI |
| `examples/demo` | the Vue app of the README screenshots | Vite |

Key files:

- `packages/protocol/src/schema.ts`: the contract between extension and daemon. Change it first.
- `packages/server/src/http.ts`: routes and the access checks; `security.ts`, `pairing.ts`.
- `packages/server/src/store.ts`: SQLite (`node:sqlite`), migrations in `migrate()`, events for SSE.
- `packages/server/src/domain.ts`: status transitions and project root precedence.
- `packages/server/src/mcp.ts`: MCP tools; `hooks/run.ts`: hook output per client.
- `packages/server/src/project-root.ts`, `dispatch.ts`: project root detection, Background agent mode.
- `packages/server/src/live-clients.ts`: Claude Code sessions with a connected channel, Live session mode.
- `packages/server/src/version.ts`: `API_LEVEL` of the daemon.
- `apps/extension/entrypoints/background.ts`: all server traffic, injection, commands, pairing.
- `apps/extension/entrypoints/overlay.content/`: `App.vue`, components, `bus.ts`.
- `apps/extension/lib/`: settings, messages between contexts, picker, DOM context, MAIN↔ISOLATED bridge.

## Commands

Run from the repository root unless noted. Node ≥ 22.13 must be the `node` in `PATH`.

```sh
pnpm install                     # also builds protocol and resolver (prepare) for wxt prepare
pnpm build                       # all packages, both extension targets, the plugin bundle
pnpm test                        # vitest in every package
pnpm typecheck                   # tsc / vue-tsc
pnpm e2e                         # Playwright: Chrome for Testing + unpacked build + fixtures + test daemon on :4949
pnpm e2e:firefox                 # system Firefox over WebDriver BiDi; FIREFOX_BIN=/path/to/zen-bin for Zen
pnpm screenshots                 # README images from examples/demo into docs/images
pnpm --filter ui-annotate test -- src/dispatch.test.ts   # one test file
```

e2e and screenshots need `pnpm build` first: they load `apps/extension/.output/*` and run
`packages/server/dist/cli.js`. Chrome for Testing comes from `npx playwright install chromium`.

## Making a change

1. Contract first: new fields go into `packages/protocol/src/schema.ts` with limits for anything the
   page controls.
2. A new or changed HTTP route or request field raises `API_LEVEL` in
   `packages/server/src/version.ts` and `SERVER_API_LEVEL` in `apps/extension/entrypoints/background.ts`
   (the MCP launcher replaces an older running daemon, the popup reports an outdated one). Update the
   expectation in `mcp.test.ts`.
3. Extension changes that a browser has to reload: raise `version` in `apps/extension/package.json`
   (Firefox-based browsers reinstall a sideloaded build only on a new version).
4. Tests next to the code: unit tests in `*.test.ts`, user-visible flows in `apps/extension/e2e/*.spec.ts`,
   Firefox-specific behavior in `apps/extension/e2e-firefox/run.mjs`.
5. Run `pnpm build && pnpm test && pnpm typecheck && pnpm e2e` (and `pnpm e2e:firefox` for
   extension changes).
6. User-facing changes go into both `README.md` and `README.ru.md`.

## Conventions

- Comments explain why, in full sentences, as in the surrounding code. No commented-out code.
- Validate everything from the page with the zod schemas; cut strings with the `LIMITS` constants.
- Text from the page reaches agents through `pageText` / the formatters only, with `PAGE_DATA_NOTE`.
- Overlay handlers accept only `isTrusted` events (`apps/extension/lib/trusted.ts`); no `v-model` on
  inputs a page script could drive.
- The daemon sends no CORS headers and accepts only the extension origin; keep `checkAccess` on every
  new route.
- Branching that decides state (transitions, root precedence) lives in `domain.ts`; the store reads
  and writes.
- Commits: Conventional Commits (`feat:`, `fix:`, `docs:`), imperative subject, body with the why.

## Known pitfalls

- `node:sqlite` needs Node ≥ 22.13. tsup must keep the `node:` prefix (`removeNodeProtocol: false`).
  Claude Code may start the plugin with an older system Node; `packages/claude-plugin/bin/ui-annotate`
  searches PATH, mise, volta, fnm, asdf, nvm and Homebrew for a suitable one.
- Branded Chrome ≥ 137 ignores `--load-extension`; e2e uses Playwright's `channel: "chromium"`
  (Chrome for Testing).
- Firefox delivers an extension command's key press to the page too. Commands are handled only in the
  background (`runCommand`); the overlay must not react to the same keys.
- Injecting the overlay content script a second time invalidates the first WXT context.
  `injectInto` asks `overlay.state` first.
- Firefox match patterns cannot contain a port: `permissionPattern` vs `registrationPattern` in
  `lib/settings.ts`.
- A raw U+2028 / U+2029 in a regex literal breaks the source file; build such regexes with
  `String.fromCharCode`.
- Server tests run in parallel; take ports from `freePort()` in `test-helpers.ts`.
- Framework internals differ by version (React 18 `_debugSource` vs React 19 `_debugStack`,
  vite-plugin-vue-inspector 7 keeping the position in the vnode). Add a fixture with `expected.json`
  for a new framework or version and check lines against the source by hand.
- Background agent mode starts real agent CLIs. Tests use a fake command (`dispatch.test.ts`) or
  `UI_ANNOTATE_CODEX_BIN=apps/extension/e2e/fake-agent.mjs` (Playwright config).
- Channels need the stdio MCP server on protocol revision 2025-11-25 or older: since Claude Code
  2.1.292 a server that negotiates 2026-07-28 is not registered as a channel. Moving to
  `@modelcontextprotocol/sdk` v2 silently breaks Live session mode.
- Live sessions are keyed by the PID of `claude` (`process.ppid` of the stdio server, `CLAUDE_PID`
  in hooks); `CLAUDE_CODE_SESSION_ID` of an MCP server goes stale after `/clear`. Names and idle/busy
  come from the undocumented `~/.claude/sessions/<pid>.json` and may disappear.
