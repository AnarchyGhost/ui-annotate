<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import type { Draft } from "../../../lib/overlay-state";
import { panelPosition } from "../../../lib/panel-position";
import { trusted } from "../../../lib/trusted";

const props = defineProps<{ draft: Draft }>();
const emit = defineEmits<{ save: []; cancel: [] }>();

const textarea = ref<HTMLTextAreaElement | null>(null);
const position = computed(() => panelPosition(props.draft.pick.anchor, 280));
const save = trusted(() => emit("save"));
const cancel = trusted(() => emit("cancel"));
// v-model would also accept synthetic `input` events dispatched by the page.
const onInput = trusted((event: Event) => (props.draft.comment = (event.target as HTMLTextAreaElement).value));
const onSelect = (key: "intent" | "severity") =>
  trusted((event: Event) => {
    const value = (event.target as HTMLSelectElement).value;
    if (key === "intent") props.draft.intent = value as Draft["intent"];
    else props.draft.severity = value as Draft["severity"];
  });
const onIntent = onSelect("intent");
const onSeverity = onSelect("severity");

onMounted(() => void nextTick(() => textarea.value?.focus()));

function onKeydown(event: KeyboardEvent) {
  if (!event.isTrusted) return;
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (props.draft.comment.trim()) emit("save");
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    emit("cancel");
  }
}
</script>

<template>
  <div class="ua-panel ua-interactive" :style="position" data-testid="ua-editor" role="dialog" aria-label="New annotation">
    <div class="ua-panel__title">
      <span class="ua-panel__target" :title="draft.label" data-testid="ua-editor-target">{{ draft.label }}</span>
      <span class="ua-badge">{{ draft.pick.kind }}</span>
    </div>
    <blockquote v-if="draft.pick.selectedText" class="ua-quote" data-testid="ua-editor-quote">{{ draft.pick.selectedText }}</blockquote>
    <div class="ua-row">
      <select :value="draft.intent" class="ua-select" aria-label="Intent" data-testid="ua-intent" @change="onIntent">
        <option value="fix">Fix</option>
        <option value="change">Change</option>
        <option value="question">Question</option>
        <option value="approve">Approve</option>
      </select>
      <select :value="draft.severity" class="ua-select" aria-label="Severity" data-testid="ua-severity" @change="onSeverity">
        <option value="blocking">Blocking</option>
        <option value="important">Important</option>
        <option value="minor">Minor</option>
      </select>
    </div>
    <textarea
      ref="textarea"
      :value="draft.comment"
      class="ua-textarea"
      placeholder="What should change?"
      data-testid="ua-comment"
      :disabled="draft.saving"
      @input="onInput"
      @keydown="onKeydown"
    />
    <div v-if="draft.error" class="ua-error" data-testid="ua-editor-error">{{ draft.error }}</div>
    <div class="ua-actions">
      <span class="ua-hint">Enter to save · Shift+Enter newline</span>
      <button class="ua-button" @click="cancel">Cancel</button>
      <button
        class="ua-button ua-button--primary"
        data-testid="ua-save"
        :disabled="!draft.comment.trim() || draft.saving"
        @click="save"
      >
        {{ draft.saving ? "Saving…" : "Save" }}
      </button>
    </div>
  </div>
</template>
