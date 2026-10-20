<script setup lang="ts">
import type { Annotation } from "@ui-annotate/protocol";
import { computed, ref } from "vue";
import type { OverlayState } from "../../../lib/overlay-state";
import { placeAnnotation } from "../../../lib/placement";

const props = defineProps<{ state: OverlayState; hideResolved: boolean }>();
const emit = defineEmits<{ open: [id: string] }>();

const hovered = ref<string | null>(null);

const visible = computed(() =>
  props.state.annotations.filter((item) => !props.hideResolved || item.status === "pending" || item.status === "acknowledged"),
);

const markers = computed(() => {
  void props.state.layoutTick;
  return visible.value.map((annotation) => {
    const { rect, attached } = placeAnnotation(annotation);
    return { annotation, attached, x: rect.x + rect.width, y: rect.y };
  });
});

const preview = (annotation: Annotation) =>
  annotation.comment.length > 140 ? `${annotation.comment.slice(0, 139)}…` : annotation.comment;
</script>

<template>
  <template v-for="marker in markers" :key="marker.annotation.id">
    <button
      class="ua-marker ua-interactive"
      :style="{ left: `${marker.x}px`, top: `${marker.y}px` }"
      :data-status="marker.annotation.status"
      :data-severity="marker.annotation.severity"
      :data-detached="!marker.attached"
      :data-testid="`ua-marker-${marker.annotation.number}`"
      :aria-label="`Annotation ${marker.annotation.number}, ${marker.annotation.status}`"
      @mouseenter="hovered = marker.annotation.id"
      @mouseleave="hovered = null"
      @click.stop="($event: MouseEvent) => $event.isTrusted && emit('open', marker.annotation.id)"
    >
      {{ marker.annotation.number }}
    </button>
    <div
      v-if="hovered === marker.annotation.id && state.openCardId !== marker.annotation.id"
      class="ua-preview"
      :style="{ left: `${marker.x + 16}px`, top: `${marker.y + 8}px` }"
    >
      {{ preview(marker.annotation) }}
    </div>
  </template>
</template>
