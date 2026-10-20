<script setup lang="ts">
import type { Rect } from "@ui-annotate/protocol";
import type { OverlayState } from "../../../lib/overlay-state";

defineProps<{ state: OverlayState }>();

const box = (rect: Rect) => ({
  left: `${rect.x}px`,
  top: `${rect.y}px`,
  width: `${rect.width}px`,
  height: `${rect.height}px`,
});
</script>

<template>
  <div v-if="state.annotating && state.hoverRect && !state.draft" class="ua-highlight" :style="box(state.hoverRect)" data-testid="ua-hover" />
  <div
    v-for="(rect, index) in state.multiRects"
    :key="index"
    class="ua-highlight ua-highlight--multi"
    :style="box(rect)"
    data-testid="ua-multi"
  >
    <span class="ua-highlight__label">{{ index + 1 }}</span>
  </div>
  <div v-if="state.areaRect" class="ua-area" :style="box(state.areaRect)" data-testid="ua-area" />
</template>
