<script setup lang="ts">
import type { DispatchAgent, LiveClient } from "@ui-annotate/protocol";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { browser } from "wxt/browser";
import type { OverlayAction, OverlaySnapshot, ServerStatus, Shortcuts } from "../../lib/messages";
import { send } from "../../lib/messaging";
import {
  DEFAULT_SERVER_URL,
  LOCAL_HOST_PATTERNS,
  isLoopbackOrigin,
  loadSettings,
  permissionPattern,
  saveSettings,
  type DeliveryMode,
  type OriginSettings,
} from "../../lib/settings";

const EXTENSION_VERSION = browser.runtime.getManifest().version;
const SERVE_COMMAND = "npx ui-annotate serve";

const ACTION_LABELS: Array<[OverlayAction, string]> = [
  ["overlay", "Show / hide on the page"],
  ["annotate", "Annotation mode"],
  ["markers", "Markers"],
  ["resolved", "Resolved annotations"],
];
const shortcuts = ref<Shortcuts | null>(null);
const AGENTS: DispatchAgent[] = ["claude", "codex", "cursor"];
const MODES: Array<[DeliveryMode, string]> = [
  ["off", "Off"],
  ["session", "Live session"],
  ["background", "Background agent"],
];
const MODE_HINT: Record<DeliveryMode, string> = {
  off: "Agent sessions in the project folder see new annotations through hooks and the channel.",
  session: "Each new annotation goes straight into one running Claude Code session through its channel.",
  background: "Each new annotation goes to a background agent run in the project root: it reads and edits files, then resolves or asks in the thread.",
};
const CHANNEL_COMMAND = "claude --dangerously-load-development-channels plugin:ui-annotate@ui-annotate-local";

const status = ref<ServerStatus | null>(null);
const tab = ref<{ id: number; origin: string; path: string } | null>(null);
const overlay = ref<OverlaySnapshot | null>(null);
const settings = ref<OriginSettings | null>(null);
const actionError = ref<string | null>(null);
const copied = ref(false);
const rootDraft = ref("");
const rootSaved = ref(false);
const token = ref("");
const serverUrl = ref("");
const connectionSaved = ref(false);
/** Live Claude Code sessions of the page's project; null until read. */
const liveClients = ref<LiveClient[] | null>(null);

/** The chosen session is not among the live ones: annotations wait for it. */
const boundOffline = computed(() => {
  const pid = settings.value?.clientPid;
  return pid != null && liveClients.value !== null && !liveClients.value.some((client) => client.pid === pid);
});

function clientTitle(client: LiveClient): string {
  if (client.name) return client.name;
  const root = overlay.value?.projectRoot;
  const relative = root && client.cwd.startsWith(root) ? client.cwd.slice(root.length).replace(/^\//, "") : client.cwd;
  return relative || "project root";
}

function clientDetails(client: LiveClient): string {
  const started = new Date(client.connectedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return [client.status, client.entrypoint && client.entrypoint !== "cli" ? client.entrypoint : null, `since ${started}`, `PID ${client.pid}`]
    .filter(Boolean)
    .join(" · ");
}

type Health = "checking" | "no-access" | "offline" | "outdated" | "pairing" | "rejected" | "connected";

const health = computed<Health>(() => {
  const value = status.value;
  if (!value) return "checking";
  if (!value.hostAccess) return "no-access";
  if (!value.reachable) return "offline";
  if (value.outdated) return "outdated";
  if (!value.tokenSet) return "pairing";
  return value.tokenValid ? "connected" : "rejected";
});

const HEALTH_LABEL: Record<Health, string> = {
  checking: "Checking…",
  "no-access": "No access to localhost",
  offline: "Server is not running",
  outdated: "Server is outdated",
  pairing: "Connecting…",
  rejected: "Server refused the token",
  connected: "Connected",
};

const healthTone = computed(() => {
  if (health.value === "connected") return "ok";
  if (health.value === "checking" || health.value === "pairing") return "wait";
  return "bad";
});

const ROOT_SOURCE_LABEL = {
  manual: "set here",
  agent: "linked by the agent",
  port: "found from the dev server process",
  path: "found from source paths",
} as const;

/** Root the server detected or an agent linked; shown when nothing is set here. */
const detectedRoot = computed(() => {
  const snapshot = overlay.value;
  if (!snapshot?.projectRoot || !snapshot.projectRootSource || snapshot.projectRootSource === "manual") return null;
  return { path: snapshot.projectRoot, how: ROOT_SOURCE_LABEL[snapshot.projectRootSource] };
});

const rootError = computed(() => {
  const value = rootDraft.value.trim();
  if (!value) return null;
  return /^(\/|[A-Za-z]:[\\/])/.test(value) ? null : "Use an absolute path, e.g. /home/me/projects/app";
});

/** The overlay can work: the server answers (pairing happens on the first request). */
const serverReady = computed(() => health.value === "connected" || health.value === "pairing" || health.value === "rejected");

async function refreshStatus() {
  status.value = await send({ type: "status" });
}

async function readOverlay() {
  if (!tab.value) return;
  overlay.value = await browser.tabs
    .sendMessage(tab.value.id, { type: "overlay.state" })
    .then((snapshot) => (snapshot as OverlaySnapshot | null) ?? null)
    .catch(() => null);
}

/** Same rule as the daemon: a session that is gone gives way to the only live one. */
async function readClients() {
  const sessionId = overlay.value?.sessionId;
  if (!sessionId || settings.value?.mode !== "session") return;
  liveClients.value = await send({ type: "clients.list", sessionId }).catch(() => null);
  const [only] = liveClients.value ?? [];
  if (only && liveClients.value?.length === 1 && settings.value.clientPid !== only.pid && (settings.value.clientPid === null || boundOffline.value)) {
    await update({ clientPid: only.pid });
  }
}

async function setMode(mode: DeliveryMode) {
  await update({ mode });
  await readClients();
}

async function readTab() {
  // ?tabId= lets e2e tests open the popup as a page for a given tab; the real popup uses the active tab.
  const forced = Number(new URLSearchParams(location.search).get("tabId"));
  const [active] = forced ? [await browser.tabs.get(forced)] : await browser.tabs.query({ active: true, currentWindow: true });
  if (!active?.id || !active.url || !/^https?:/.test(active.url)) return;
  const url = new URL(active.url);
  tab.value = { id: active.id, origin: url.origin, path: url.pathname };
  settings.value = await send({ type: "origin.get", origin: url.origin });
  rootDraft.value = settings.value.projectRoot ?? "";
}

/** Opening the popup shows the overlay on the page; the mode is left as it is. */
async function showOverlay() {
  if (!tab.value) return;
  actionError.value = null;
  try {
    await send({ type: "tab.show", tabId: tab.value.id });
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
  }
  // The overlay pairs and connects when it opens its session.
  setTimeout(() => void Promise.all([readOverlay(), refreshStatus()]), 400);
}

/** Firefox can enable the extension without host access; asked here, in the click handler. */
async function grantLocalAccess() {
  const granted = await browser.permissions.request({ origins: LOCAL_HOST_PATTERNS });
  if (!granted) return;
  await refreshStatus();
  await showOverlay();
}

/** Firefox 137+ opens its shortcut editor; Chrome has a page for it. */
async function changeShortcuts() {
  const commands = browser.commands as typeof browser.commands & { openShortcutSettings?: () => Promise<void> };
  if (commands.openShortcutSettings) await commands.openShortcutSettings();
  else await browser.tabs.create({ url: "chrome://extensions/shortcuts" });
  window.close();
}

async function copyServeCommand() {
  await navigator.clipboard.writeText(SERVE_COMMAND).catch(() => undefined);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}

async function update(patch: Partial<OriginSettings>) {
  if (!tab.value) return;
  settings.value = await send({ type: "origin.set", origin: tab.value.origin, settings: patch });
}

async function saveDelay(event: Event) {
  const input = event.target as HTMLInputElement;
  const seconds = Math.min(Math.max(Math.round(Number(input.value) || 0), 0), 600);
  input.value = String(seconds);
  await update({ dispatchDelaySeconds: seconds });
}

async function saveRoot() {
  if (rootError.value) return;
  await update({ projectRoot: rootDraft.value.trim() || null });
  rootSaved.value = true;
  setTimeout(() => (rootSaved.value = false), 1500);
}

/** permissions.request must run in the click handler: it needs the user gesture. */
async function toggleAlwaysOn(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!tab.value) return;
  if (input.checked && !isLoopbackOrigin(tab.value.origin)) {
    const granted = await browser.permissions.request({ origins: [permissionPattern(tab.value.origin)] });
    if (!granted) {
      input.checked = false;
      return;
    }
  }
  await update({ alwaysOn: input.checked });
}

async function saveConnection() {
  await saveSettings({ token: token.value.trim(), serverUrl: serverUrl.value.trim() || DEFAULT_SERVER_URL });
  connectionSaved.value = true;
  setTimeout(() => (connectionSaved.value = false), 1500);
  await refreshStatus();
}

let poll: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  const current = await loadSettings();
  token.value = current.token;
  serverUrl.value = current.serverUrl;
  await Promise.all([refreshStatus(), readTab(), send({ type: "shortcuts.get" }).then((value) => (shortcuts.value = value))]);
  // Opening the popup is the icon click: show the overlay on the page, unless the server cannot
  // be reached (the notice says what to fix first). Annotation mode stays a separate shortcut.
  if (tab.value) {
    await readOverlay();
    if (serverReady.value && (!overlay.value || overlay.value.hidden)) await showOverlay();
  }
  await readClients();
  poll = setInterval(() => void readOverlay().then(readClients), 1000);
});

onBeforeUnmount(() => {
  if (poll) clearInterval(poll);
});
</script>

<template>
  <main class="popup">
    <header class="head">
      <div class="brand">
        <span class="logo" aria-hidden="true" />
        <span>ui-annotate</span>
      </div>
      <span class="pill" :data-tone="healthTone" data-testid="popup-status">{{ HEALTH_LABEL[health] }}</span>
    </header>

    <section v-if="health === 'no-access'" class="notice" data-tone="bad" data-testid="popup-host-access">
      <p>The browser has not given the extension access to <code>localhost</code> and <code>127.0.0.1</code>, so it cannot reach the server or your dev pages.</p>
      <button class="btn primary" data-testid="popup-grant" @click="grantLocalAccess">Allow access</button>
    </section>
    <section v-else-if="health === 'offline'" class="notice" data-tone="bad" data-testid="popup-offline">
      <p>Start the local server, or open a Claude Code session with the ui-annotate plugin: it starts the server itself.</p>
      <div class="command">
        <code>{{ SERVE_COMMAND }}</code>
        <button class="btn small" @click="copyServeCommand">{{ copied ? "Copied" : "Copy" }}</button>
      </div>
    </section>
    <section v-else-if="health === 'outdated'" class="notice" data-tone="bad" data-testid="popup-outdated">
      <p>The running server is older than the extension. Stop it and start it again, or open a new Claude Code session: the plugin replaces it.</p>
    </section>
    <section v-else-if="health === 'rejected'" class="notice" data-tone="bad">
      <p>The server refused the stored token. Annotate a page to pair again, or paste the token below.</p>
    </section>

    <section v-if="tab" class="page" data-testid="popup-page">
      <div class="page-head">
        <div class="page-id">
          <span class="origin" :title="tab.origin">{{ tab.origin.replace(/^https?:\/\//, "") }}</span>
          <span class="path" :title="tab.path">{{ tab.path }}</span>
        </div>
        <span v-if="overlay" class="counts" data-testid="popup-counts">
          <strong>{{ overlay.open }}</strong> open · {{ overlay.total }} total
        </span>
      </div>
      <p class="mode" data-testid="popup-mode">
        <span class="dot" :data-on="overlay?.annotating === true" />
        {{
          !overlay
            ? "Not on this page yet"
            : overlay.hidden
              ? "Hidden on this page"
              : overlay.annotating
                ? "Annotating: click an element, select text or drag an area"
                : "Shown; annotation mode is off"
        }}
      </p>
      <p v-if="actionError" class="error" data-testid="popup-error">{{ actionError }}</p>
      <p v-else-if="overlay?.error" class="error">{{ overlay.error }}</p>
    </section>
    <section v-else class="page empty">
      <p class="hint">Open a page of your dev app to annotate it.</p>
    </section>

    <section v-if="tab && settings" class="settings">
      <h2>This site</h2>
      <label class="field">
        <span class="label">Project root</span>
        <span class="row">
          <input
            v-model="rootDraft"
            :placeholder="detectedRoot?.path ?? 'detected automatically, or /home/me/projects/app'"
            spellcheck="false"
            data-testid="popup-root"
            @keydown.enter="saveRoot"
            @blur="saveRoot"
          />
          <span v-if="rootSaved" class="saved">Saved</span>
        </span>
        <span v-if="rootError" class="error">{{ rootError }}</span>
        <span v-else-if="detectedRoot && !rootDraft" class="hint" data-testid="popup-root-detected">
          Detected ({{ detectedRoot.how }}). Type a path to override.
        </span>
        <span v-else class="hint">
          Usually detected from the dev server or source paths. Agent paths become relative to it, and its annotations reach only
          the agent session in this folder.
        </span>
      </label>
      <label class="switch">
        <input type="checkbox" :checked="settings.alwaysOn" data-testid="popup-always-on" @change="toggleAlwaysOn" />
        <span class="track" />
        <span class="text">
          <span class="label">Load on every visit</span>
          <span class="hint">The toolbar and markers appear on load, without clicking the icon.</span>
        </span>
      </label>
      <label class="switch">
        <input type="checkbox" :checked="settings.includeHash" @change="update({ includeHash: ($event.target as HTMLInputElement).checked })" />
        <span class="track" />
        <span class="text">
          <span class="label">Hash routes are separate pages</span>
          <span class="hint">For apps routed by <code>#/path</code>.</span>
        </span>
      </label>
      <div class="field">
        <span class="label">New annotations go to</span>
        <div class="segmented" role="radiogroup" aria-label="New annotations go to">
          <button
            v-for="[mode, label] in MODES"
            :key="mode"
            role="radio"
            :aria-checked="settings.mode === mode"
            :class="{ active: settings.mode === mode }"
            :data-testid="`popup-mode-${mode}`"
            @click="setMode(mode)"
          >
            {{ label }}
          </button>
        </div>
        <span class="hint">{{ MODE_HINT[settings.mode] }}</span>
      </div>
      <div v-if="settings.mode === 'session'" class="dispatch" data-testid="popup-live">
        <ul v-if="liveClients?.length || boundOffline" class="clients" role="radiogroup" aria-label="Claude Code session">
          <li v-for="client in liveClients" :key="client.pid">
            <button
              role="radio"
              :aria-checked="settings.clientPid === client.pid"
              :class="{ active: settings.clientPid === client.pid }"
              :data-testid="`popup-client-${client.pid}`"
              @click="update({ clientPid: client.pid })"
            >
              <span class="client-name">{{ clientTitle(client) }}</span>
              <span class="hint">{{ clientDetails(client) }}</span>
            </button>
          </li>
          <li v-if="boundOffline" class="offline" data-testid="popup-client-offline">
            The chosen session (PID {{ settings.clientPid }}) is not running: annotations wait for it.
          </li>
        </ul>
        <span v-if="overlay && !settings.projectRoot && !overlay.projectRoot" class="error">No project root for this page yet: sessions are matched by it.</span>
        <template v-else-if="!liveClients?.length">
          <span class="hint" data-testid="popup-live-empty">No Claude Code session with the ui-annotate channel in this project. Start one in the project folder:</span>
          <code class="command-line">{{ CHANNEL_COMMAND }}</code>
        </template>
      </div>
      <div v-if="settings.mode === 'background'" class="dispatch" data-testid="popup-dispatch">
        <div class="segmented" role="radiogroup" aria-label="Agent">
          <button
            v-for="agent in AGENTS"
            :key="agent"
            role="radio"
            :aria-checked="settings.agent === agent"
            :class="{ active: settings.agent === agent }"
            :data-testid="`popup-agent-${agent}`"
            @click="update({ agent })"
          >
            {{ agent }}
          </button>
        </div>
        <label class="delay">
          <span class="label">Delay</span>
          <input type="number" min="0" max="600" step="1" :value="settings.dispatchDelaySeconds" data-testid="popup-delay" @change="saveDelay" />
          <span class="hint">s</span>
        </label>
        <span v-if="overlay && !settings.projectRoot && !overlay.projectRoot" class="error">No project root for this page yet: runs start only for pages with one.</span>
        <span v-else class="hint">Annotations left within the delay go into one run.</span>
      </div>
    </section>

    <section class="shortcuts" data-testid="popup-shortcuts">
      <h2>Shortcuts</h2>
      <ul>
        <li v-for="[action, label] in ACTION_LABELS" :key="action">
          <span>{{ label }}</span>
          <kbd v-if="shortcuts?.[action]" :data-testid="`popup-shortcut-${action}`">{{ shortcuts[action] }}</kbd>
          <span v-else class="unset" :data-testid="`popup-shortcut-${action}`">not set</span>
        </li>
      </ul>
      <button class="btn small" data-testid="popup-change-shortcuts" @click="changeShortcuts">Change shortcuts</button>
    </section>

    <details class="connection">
      <summary>
        <span>{{ (status?.serverUrl ?? serverUrl).replace(/^https?:\/\//, "") }}</span>
        <span class="versions">server {{ status?.version ? `v${status.version}` : "—" }} · extension v{{ EXTENSION_VERSION }}</span>
      </summary>
      <label class="field">
        <span class="label">Server</span>
        <input v-model="serverUrl" spellcheck="false" data-testid="popup-server" />
      </label>
      <label class="field">
        <span class="label">Token</span>
        <input v-model="token" type="password" autocomplete="off" placeholder="paired automatically" data-testid="popup-token" />
        <span class="hint">Filled in automatically. Manual fallback: <code>npx ui-annotate token</code></span>
      </label>
      <div class="row end">
        <span v-if="connectionSaved" class="saved">Saved</span>
        <button class="btn small" data-testid="popup-save" @click="saveConnection">Save</button>
      </div>
    </details>
  </main>
</template>
