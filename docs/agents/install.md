# Installing ui-annotate: instructions for a coding agent

You are a coding agent (Claude Code, Codex, Cursor or similar) asked to set up ui-annotate for the
user. Follow the steps in order, run the checks, and report what you did and what the user still has
to click. Ask before writing outside the clone and the agent configs named below.

## 1. Check prerequisites

```sh
node --version     # need >= 22.13 (node:sqlite)
pnpm --version     # need 9.x; if missing: corepack enable && corepack prepare pnpm@9.15.0 --activate
git --version
```

If `node` is older, look for a newer one (mise, volta, fnm, nvm, asdf, Homebrew) and use it for
every command below; tell the user which binary you used. Do not upgrade the system Node without
asking.

## 2. Clone and build

Ask where to clone if the user did not say; `~/tools/ui-annotate` is a reasonable default.

```sh
git clone https://github.com/AnarchyGhost/ui-annotate.git ~/tools/ui-annotate
cd ~/tools/ui-annotate
pnpm install
pnpm build
```

Check: `apps/extension/.output/chrome-mv3/manifest.json`, `apps/extension/.output/firefox-mv3/manifest.json`
and `packages/claude-plugin/dist/cli.js` exist.

## 3. Start the daemon and check it

```sh
pnpm exec ui-annotate serve &        # or let the first MCP connection start it
curl -s http://127.0.0.1:4848/health # {"ok":true,"name":"ui-annotate",...}
pnpm exec ui-annotate status
```

## 4. Connect the agent the user works with

Do only the ones the user uses; ask if unsure.

**Claude Code** (plugin: MCP server, skill, hooks, channel):

```sh
claude plugin marketplace add ~/tools/ui-annotate
claude plugin install ui-annotate@ui-annotate-local
claude mcp list            # expect: plugin:ui-annotate:ui-annotate ... Connected
```

The plugin runs from the clone (`packages/claude-plugin`), so `pnpm build` after a `git pull` updates
it. Restart running Claude Code sessions to load it.

**Codex** (`~/.codex/config.toml` and `~/.codex/hooks.json`; back them up first):

```sh
cp ~/.codex/config.toml ~/.codex/config.toml.bak 2>/dev/null; cp ~/.codex/hooks.json ~/.codex/hooks.json.bak 2>/dev/null
pnpm exec ui-annotate init codex            # prints what will be written
pnpm exec ui-annotate init codex --write
```

Tell the user to open Codex once and approve the hooks in `/hooks`; Codex does not run untrusted user
hooks.

**Cursor** (per project: `.cursor/mcp.json`, `.cursor/hooks.json`):

```sh
cd /path/to/the/users/app
~/tools/ui-annotate/node_modules/.bin/ui-annotate init cursor --write
```

`init` writes the absolute path of the Node.js running it into the config: run it with the Node
≥ 22.13 from step 1.

## 5. Hand over the browser part

You cannot click in the user's browser. Give the user these steps verbatim:

- **Chrome / Edge / Brave**: open `chrome://extensions`, enable *Developer mode*, *Load unpacked*,
  choose `~/tools/ui-annotate/apps/extension/.output/chrome-mv3`.
- **Firefox**: open `about:debugging#/runtime/this-firefox`, *Load Temporary Add-on*, choose
  `~/tools/ui-annotate/apps/extension/.output/firefox-mv3/manifest.json`. It is removed on restart;
  Developer Edition, Nightly and Zen keep it with `xpinstall.signatures.required = false` in
  `about:config` and the build zipped as an `.xpi`
  (`pnpm --filter extension exec wxt zip -b firefox --mv3` → `apps/extension/.output/*-firefox.zip`).
- Then: open the dev app, click the ui-annotate icon. The popup must say **Connected**.

No token to paste: the extension pairs with the daemon on first use.

## 6. Verify end to end

1. The user opens their dev app (for example `http://localhost:5173`), presses `Ctrl/Cmd+Shift+1`,
   clicks an element and saves a note.
2. You call the MCP tool `get_pending` (or `curl` with the token:
   `curl -s -H "Authorization: Bearer $(pnpm exec ui-annotate token)" http://127.0.0.1:4848/annotations?status=open`).
3. Expect the note with `file:line` relative to the project. If the path is absolute or missing, see
   *Project root* below.
4. Optionally `acknowledge` and `reply` to it: the user sees your message in the overlay.

## Troubleshooting

| Popup says | Cause | Fix |
|---|---|---|
| Server is not running | no daemon on the configured port | `pnpm exec ui-annotate serve`; check the port under *Connection* in the popup |
| Server is outdated | an older daemon from a previous build is running | stop it (`kill` the `pid` from `/health`), start the new one; MCP clients replace it themselves |
| Server refused the token | the daemon's token file changed | the extension pairs again on the next request; otherwise paste `pnpm exec ui-annotate token` under *Connection* |
| No access to localhost | Firefox: host permissions are opt-in | press *Allow access* in the popup |

- **Project root missing or wrong**: the popup shows the detected root under *This site*. Set it by
  hand there, or call the MCP tool `link_page(url)` from the project directory.
- **Firefox refuses to pair** after reinstalling: `pnpm exec ui-annotate unpair`, then open the popup
  again.
- **MCP server fails in Claude Code** with an old Node: set `UI_ANNOTATE_NODE=/path/to/node` in the
  environment Claude Code starts with.
- **Live session lists no sessions**: start Claude Code in the project folder with
  `claude --dangerously-load-development-channels plugin:ui-annotate@ui-annotate-local`; the page
  needs a project root. A session started without the flag is listed, yet drops channel messages.
  With the plugin in `allowedChannelPlugins` of the managed settings (README, *Live session*),
  `claude --channels plugin:ui-annotate@ui-annotate-local` replaces the flag. `--channels` for a
  plugin outside the allowlist starts Claude Code without the channel.
- **Background agent does nothing**: the daemon runs `claude`, `codex` or `cursor-agent` from its own
  `PATH`; set `UI_ANNOTATE_CLAUDE_BIN` / `UI_ANNOTATE_CODEX_BIN` / `UI_ANNOTATE_CURSOR_BIN` for the
  daemon and restart it. The annotation thread shows the error.
- Daemon data: `~/.local/share/ui-annotate/db.sqlite`; token: `~/.config/ui-annotate/token`;
  overrides: `UI_ANNOTATE_PORT`, `UI_ANNOTATE_DB`, `UI_ANNOTATE_TOKEN_FILE`.

## Updating

```sh
cd ~/tools/ui-annotate && git pull && pnpm install && pnpm build
```

Then reload the extension (Chrome: the reload button in `chrome://extensions`; Firefox: load the
add-on again). A daemon with an older API level is replaced by the next MCP connection.

## Uninstalling

```sh
claude plugin uninstall ui-annotate@ui-annotate-local
claude plugin marketplace remove ui-annotate-local
```

Remove `[mcp_servers.ui-annotate]` from `~/.codex/config.toml` and the ui-annotate entries from
`~/.codex/hooks.json` (or restore the backups), delete `.cursor/mcp.json` / `.cursor/hooks.json`
entries in Cursor projects, remove the extension in the browser. Data lives in
`~/.local/share/ui-annotate` and `~/.config/ui-annotate`.
