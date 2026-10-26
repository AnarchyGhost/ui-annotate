<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { send } from "../../lib/messaging";
import {
  createState,
  draftFromPick,
  openSession,
  rectsOf,
  saveDraft,
  subscribe,
} from "../../lib/overlay-state";
import { documentRect } from "../../lib/dom-context";
import { Picker } from "../../lib/picker";
import type { OverlayAction, Shortcuts } from "../../lib/messages";
import { loadPrefs, savePrefs, type Prefs } from "../../lib/prefs";
import AnnotationCard from "./components/AnnotationCard.vue";
import AnnotationEditor from "./components/AnnotationEditor.vue";
import HighlightLayer from "./components/HighlightLayer.vue";
import MarkerLayer from "./components/MarkerLayer.vue";
import ToolbarPanel from "./components/ToolbarPanel.vue";
import type { OverlayBus } from "./bus";

const props = defineProps<{ host: Element; bus: OverlayBus }>();

const state = createState();
const prefs = ref<Prefs>({ theme: "auto", collapsed: false, position: null });
/** Hidden entirely by the overlay command; the session and its live updates keep running. */
const hidden = ref(false);
const shortcuts = ref<Shortcuts | null>(null);
const hoverElement = ref<Element | null>(null);
let multiElements: Element[] = [];

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const prefersDark = ref(systemDark.matches);
const theme = computed(() => (prefs.value.theme === "auto" ? (prefersDark.value ? "dark" : "light") : prefs.value.theme));
const hideResolved = computed(() => state.origin?.hideResolved ?? false);

const picker = new Picker(props.host, {
  onHover(element) {
    hoverElement.value = element;
    state.hoverRect = element ? documentRect(element) : null;
  },
  onMultiChange(elements) {
    multiElements = elements;
    state.multiRects = rectsOf(elements);
  },
  onAreaChange(rect) {
    state.areaRect = rect;
  },
  onPick(pick) {
    if (state.draft?.saving) return;
    state.hoverRect = null;
    state.openCardId = null;
    state.draft = draftFromPick(pick);
  },
});

function setAnnotating(on: boolean) {
  state.annotating = on;
  if (on) picker.start();
  else {
    picker.stop();
    picker.clearMulti();
    state.hoverRect = null;
  }
}

function commitMulti() {
  picker.commitMulti();
}

function cancelDraft() {
  state.draft = null;
  window.getSelection()?.removeAllRanges();
}

async function toggleHideResolved() {
  if (!state.origin) return;
  state.origin = await send({ type: "origin.set", origin: location.origin, settings: { hideResolved: !state.origin.hideResolved } });
}

function updatePrefs(patch: Partial<Prefs>) {
  prefs.value = { ...prefs.value, ...patch };
  void savePrefs(location.origin, prefs.value);
}

function cycleTheme() {
  const order: Prefs["theme"][] = ["auto", "light", "dark"];
  updatePrefs({ theme: order[(order.indexOf(prefs.value.theme) + 1) % order.length]! });
}

function isTyping(event: KeyboardEvent): boolean {
  const target = event.composedPath()[0];
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** Esc closes the innermost thing first: editor, card, multi-selection, then annotation mode. */
function escape(): boolean {
  if (state.draft) return (cancelDraft(), true);
  if (state.openCardId) return ((state.openCardId = null), true);
  if (picker.multiSelection.length > 0) return (picker.clearMulti(), true);
  if (state.annotating) return (setAnnotating(false), true);
  return false;
}

/**
 * Only Esc and Enter are handled here. The toggles are extension commands (manifest `commands`,
 * rebindable in the browser) delivered through the background: Firefox would also hand the same
 * key to the page, and handling it here too would apply every press twice.
 */
function onKeydown(event: KeyboardEvent) {
  // Page scripts can dispatch keydown on window; only real keys drive the overlay.
  if (!event.isTrusted || hidden.value) return;
  if (event.key === "Escape") {
    if (escape()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    return;
  }
  if (event.key === "Enter" && picker.multiSelection.length > 0 && !isTyping(event)) {
    event.preventDefault();
    commitMulti();
  }
}

/** Hides everything (toolbar, markers, cards) and leaves annotation mode; the page is untouched. */
function setHidden(on: boolean) {
  hidden.value = on;
  if (!on) return;
  setAnnotating(false);
  state.draft = null;
  state.openCardId = null;
}

function runAction(action: OverlayAction) {
  if (action === "overlay") return setHidden(!hidden.value);
  setHidden(false);
  if (action === "annotate") setAnnotating(!state.annotating);
  if (action === "markers") state.markersHidden = !state.markersHidden;
  if (action === "resolved") void toggleHideResolved();
}

let frame = 0;
function scheduleLayout() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    state.layoutTick += 1;
    if (hoverElement.value) state.hoverRect = documentRect(hoverElement.value);
    if (multiElements.length) state.multiRects = rectsOf(multiElements);
  });
}

const mutations = new MutationObserver((records) => {
  if (records.some((record) => !props.host.contains(record.target))) scheduleLayout();
});

let unsubscribe: (() => void) | null = null;
let subscribedId: string | null = null;

/**
 * The only place that (re)subscribes: first load, SPA navigation and Retry. A navigation that
 * keeps the session (hash change with includeHash off) keeps the subscription.
 */
async function refreshSession() {
  await openSession(state);
  const id = state.session?.id ?? null;
  if (!id || (id === subscribedId && unsubscribe)) return;
  unsubscribe?.();
  unsubscribe = subscribe(state);
  subscribedId = id;
}

onMounted(async () => {
  window.addEventListener("keydown", onKeydown, { capture: true });
  window.addEventListener("scroll", scheduleLayout, { capture: true, passive: true });
  window.addEventListener("resize", scheduleLayout, { passive: true });
  systemDark.addEventListener("change", (event) => (prefersDark.value = event.matches));
  mutations.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });

  props.bus.listen((command) => {
    if (command === "show") return setHidden(false);
    if (command === "activate") {
      setHidden(false);
      return setAnnotating(true);
    }
    runAction(command.action);
  });
  props.bus.provide(() => ({
    hidden: hidden.value,
    annotating: state.annotating,
    connection: state.connection,
    error: state.error,
    open: state.annotations.filter((item) => item.status === "pending" || item.status === "acknowledged").length,
    total: state.annotations.length,
    sessionId: state.session?.id ?? null,
    projectRoot: state.session?.projectRoot ?? null,
    projectRootSource: state.session?.projectRootSource ?? null,
  }));

  prefs.value = await loadPrefs(location.origin).catch(() => prefs.value);
  shortcuts.value = await send({ type: "shortcuts.get" }).catch(() => null);
  await refreshSession();
});

// SPA navigation changes the page; the session follows origin + pathname.
let lastPath = location.pathname + location.hash;
const navigationTimer = setInterval(() => {
  const path = location.pathname + location.hash;
  if (path === lastPath) return;
  lastPath = path;
  state.openCardId = null;
  state.draft = null;
  void refreshSession();
}, 500);

onBeforeUnmount(() => {
  picker.stop();
  unsubscribe?.();
  mutations.disconnect();
  clearInterval(navigationTimer);
  window.removeEventListener("keydown", onKeydown, { capture: true });
  window.removeEventListener("scroll", scheduleLayout, { capture: true });
  window.removeEventListener("resize", scheduleLayout);
});

defineExpose({ state });
</script>

<template>
  <div v-if="!hidden" class="ua-root" :data-theme="theme" data-testid="ua-root">
    <HighlightLayer :state="state" />
    <MarkerLayer
      v-if="!state.markersHidden"
      :state="state"
      :hide-resolved="hideResolved"
      @open="(id: string) => ((state.openCardId = id), (state.draft = null))"
    />
    <AnnotationEditor
      v-if="state.draft"
      :draft="state.draft"
      @save="saveDraft(state)"
      @cancel="cancelDraft"
    />
    <AnnotationCard
      v-if="state.openCardId"
      :state="state"
      :annotation-id="state.openCardId"
      @close="state.openCardId = null"
    />
    <ToolbarPanel
      :state="state"
      :prefs="prefs"
      :hide-resolved="hideResolved"
      :theme="theme"
      :shortcuts="shortcuts"
      @toggle-annotate="setAnnotating(!state.annotating)"
      @toggle-markers="state.markersHidden = !state.markersHidden"
      @toggle-resolved="toggleHideResolved"
      @cycle-theme="cycleTheme"
      @commit-multi="commitMulti"
      @retry="refreshSession"
      @update-prefs="updatePrefs"
    />
  </div>
</template>
