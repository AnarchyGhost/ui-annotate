<script setup lang="ts">
import { computed, ref } from "vue";
import type { OverlayAction, Shortcuts } from "../../../lib/messages";
import type { OverlayState } from "../../../lib/overlay-state";
import type { Prefs } from "../../../lib/prefs";
import { trusted } from "../../../lib/trusted";

const props = defineProps<{
  state: OverlayState;
  prefs: Prefs;
  hideResolved: boolean;
  theme: string;
  shortcuts: Shortcuts | null;
}>();

/** Tooltip with the key the user bound to this action in the browser, if any. */
const hint = (label: string, action: OverlayAction) => {
  const key = props.shortcuts?.[action];
  return key ? `${label} (${key})` : label;
};
const emit = defineEmits<{
  toggleAnnotate: [];
  toggleMarkers: [];
  toggleResolved: [];
  cycleTheme: [];
  commitMulti: [];
  retry: [];
  updatePrefs: [patch: Partial<Prefs>];
}>();

const click = {
  annotate: trusted(() => emit("toggleAnnotate")),
  commitMulti: trusted(() => emit("commitMulti")),
  markers: trusted(() => emit("toggleMarkers")),
  resolved: trusted(() => emit("toggleResolved")),
  theme: trusted(() => emit("cycleTheme")),
  retry: trusted(() => emit("retry")),
  collapse: trusted(() => emit("updatePrefs", { collapsed: !props.prefs.collapsed })),
};

const MARGIN = 16;
const panel = ref<HTMLElement | null>(null);
const dragOffset = ref<{ x: number; y: number } | null>(null);
const livePosition = ref<{ x: number; y: number } | null>(null);

const openCount = computed(() => props.state.annotations.filter((item) => item.status === "pending" || item.status === "acknowledged").length);

const style = computed(() => {
  const position = livePosition.value ?? props.prefs.position;
  if (!position) return { right: `${MARGIN}px`, bottom: `${MARGIN}px` };
  const width = panel.value?.offsetWidth ?? 200;
  const height = panel.value?.offsetHeight ?? 40;
  const x = Math.min(Math.max(position.x, 0), window.innerWidth - width);
  const y = Math.min(Math.max(position.y, 0), window.innerHeight - height);
  return { left: `${x}px`, top: `${y}px` };
});

const statusTitle = computed(() => {
  if (props.state.connection === "online") return "Connected to ui-annotate server";
  if (props.state.connection === "offline") return props.state.error ?? "Server offline";
  return "Connecting…";
});

function startDrag(event: PointerEvent) {
  const rect = panel.value?.getBoundingClientRect();
  if (!rect) return;
  dragOffset.value = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  (event.target as HTMLElement).setPointerCapture(event.pointerId);
}

function drag(event: PointerEvent) {
  if (!dragOffset.value) return;
  livePosition.value = { x: event.clientX - dragOffset.value.x, y: event.clientY - dragOffset.value.y };
}

function endDrag() {
  if (!dragOffset.value) return;
  dragOffset.value = null;
  if (livePosition.value) emit("updatePrefs", { position: livePosition.value });
  livePosition.value = null;
}
</script>

<template>
  <div
    ref="panel"
    class="ua-toolbar ua-interactive"
    :style="style"
    data-testid="ua-toolbar"
    role="toolbar"
    aria-label="ui-annotate"
  >
    <div
      class="ua-toolbar__handle"
      title="Drag"
      @pointerdown="startDrag"
      @pointermove="drag"
      @pointerup="endDrag"
      @pointercancel="endDrag"
    />
    <span class="ua-status" :data-state="state.connection" :title="statusTitle" data-testid="ua-status" />
    <template v-if="!prefs.collapsed">
      <button
        class="ua-button"
        :aria-pressed="state.annotating"
        data-testid="ua-annotate"
        :title="hint('Annotation mode: click elements, select text or drag an area', 'annotate')"
        @click="click.annotate"
      >
        Annotate
      </button>
      <button
        v-if="state.multiRects.length > 0"
        class="ua-button ua-button--primary"
        data-testid="ua-commit-multi"
        title="Annotate the selected elements (Enter)"
        @click="click.commitMulti"
      >
        {{ state.multiRects.length }} selected
      </button>
      <button
        class="ua-button"
        :aria-pressed="state.markersHidden"
        data-testid="ua-hide-markers"
        :title="hint('Hide the numbered markers on the page', 'markers')"
        @click="click.markers"
      >
        Hide markers
      </button>
      <button
        class="ua-button"
        :aria-pressed="hideResolved"
        data-testid="ua-hide-resolved"
        :title="hint('Hide annotations the agent resolved or dismissed', 'resolved')"
        @click="click.resolved"
      >
        Hide resolved
      </button>
      <button class="ua-button" :title="`Theme: ${prefs.theme}`" @click="click.theme">
        {{ theme === "dark" ? "☾" : "☀" }}
      </button>
      <button v-if="state.connection === 'offline'" class="ua-button" title="Reconnect" @click="click.retry">Retry</button>
    </template>
    <span class="ua-count" :title="`${openCount} open annotation(s)`" data-testid="ua-count">{{ openCount }}</span>
    <button
      class="ua-button"
      :title="prefs.collapsed ? 'Expand' : 'Collapse'"
      @click="click.collapse"
    >
      {{ prefs.collapsed ? "‹" : "›" }}
    </button>
  </div>
  <div
    v-if="state.connection === 'offline' && state.error"
    class="ua-toast ua-interactive"
    :style="{ right: '16px', bottom: '72px' }"
    data-testid="ua-error"
  >
    {{ state.error }}
  </div>
</template>
