<script setup lang="ts">
import { formatLocation, type AnnotationStatus } from "@ui-annotate/protocol";
import { computed, ref, watch } from "vue";
import { send } from "../../../lib/messaging";
import { removeAnnotation, upsertAnnotation, type OverlayState } from "../../../lib/overlay-state";
import { panelPosition } from "../../../lib/panel-position";
import { placeAnnotation } from "../../../lib/placement";
import { trusted } from "../../../lib/trusted";

const props = defineProps<{ state: OverlayState; annotationId: string }>();
const emit = defineEmits<{ close: [] }>();

const annotation = computed(() => props.state.annotations.find((item) => item.id === props.annotationId) ?? null);
const editing = ref(false);
const editText = ref("");
const reply = ref("");
const busy = ref(false);
const error = ref<string | null>(null);

watch(
  () => props.annotationId,
  () => {
    editing.value = false;
    reply.value = "";
    error.value = null;
  },
);

const position = computed(() => {
  void props.state.layoutTick;
  if (!annotation.value) return { left: "12px", top: "12px" };
  const { rect } = placeAnnotation(annotation.value);
  return panelPosition({ x: rect.x + rect.width - window.scrollX, y: rect.y - window.scrollY }, 360);
});

const location = computed(() => {
  const source = annotation.value?.targets[0]?.source;
  if (!source) return null;
  const where = formatLocation(source);
  if (!where) return source.reason ? `source: ${source.reason}` : null;
  return source.componentName ? `${where} · <${source.componentName}>` : where;
});

const isOpen = computed(() => annotation.value?.status === "pending" || annotation.value?.status === "acknowledged");

const KIND_LABEL: Record<string, string> = {
  comment: "comment",
  reply: "reply",
  acknowledge: "working on it",
  resolve: "resolved",
  dismiss: "dismissed",
  reopen: "reopened",
};

async function run(work: () => Promise<void>) {
  busy.value = true;
  error.value = null;
  try {
    await work();
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure);
  } finally {
    busy.value = false;
  }
}

const setStatus = (status: AnnotationStatus) =>
  run(async () => upsertAnnotation(props.state, await send({ type: "annotation.patch", id: props.annotationId, patch: { status } })));

const saveEdit = () =>
  run(async () => {
    const comment = editText.value.trim();
    if (!comment) return;
    upsertAnnotation(props.state, await send({ type: "annotation.patch", id: props.annotationId, patch: { comment } }));
    editing.value = false;
  });

const sendReply = () =>
  run(async () => {
    const body = reply.value.trim();
    if (!body) return;
    upsertAnnotation(props.state, await send({ type: "annotation.comment", id: props.annotationId, body }));
    reply.value = "";
  });

const remove = () =>
  run(async () => {
    await send({ type: "annotation.delete", id: props.annotationId });
    removeAnnotation(props.state, props.annotationId);
    emit("close");
  });

function startEdit() {
  editText.value = annotation.value?.comment ?? "";
  editing.value = true;
}

// v-model would also accept synthetic `input` events dispatched by the page.
const onEditInput = trusted((event: Event) => (editText.value = (event.target as HTMLTextAreaElement).value));
const onReplyInput = trusted((event: Event) => (reply.value = (event.target as HTMLTextAreaElement).value));

/** Every action that changes the annotation needs a real user event. */
const click = {
  close: trusted(() => emit("close")),
  edit: trusted(startEdit),
  cancelEdit: trusted(() => (editing.value = false)),
  saveEdit: trusted(() => void saveEdit()),
  dismiss: trusted(() => void setStatus("dismissed")),
  reopen: trusted(() => void setStatus("pending")),
  remove: trusted(() => void remove()),
  send: trusted(() => void sendReply()),
};

function onReplyKeydown(event: KeyboardEvent) {
  if (!event.isTrusted) return;
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void sendReply();
  }
}
</script>

<template>
  <div v-if="annotation" class="ua-panel ua-interactive" :style="position" data-testid="ua-card" role="dialog" :aria-label="`Annotation ${annotation.number}`">
    <div class="ua-panel__title">
      <span>#{{ annotation.number }}</span>
      <span class="ua-badge" :data-status="annotation.status" data-testid="ua-card-status">{{ annotation.status }}</span>
      <span class="ua-badge">{{ annotation.intent }}</span>
      <span class="ua-badge">{{ annotation.severity }}</span>
      <span class="ua-panel__target" />
      <button class="ua-button" title="Close" @click="click.close">×</button>
    </div>
    <div v-if="location" class="ua-source" data-testid="ua-card-source">{{ location }}</div>
    <blockquote v-if="annotation.selectedText" class="ua-quote">{{ annotation.selectedText }}</blockquote>
    <template v-if="editing">
      <textarea :value="editText" class="ua-textarea" data-testid="ua-card-edit" @input="onEditInput" />
      <div class="ua-actions">
        <button class="ua-button" @click="click.cancelEdit">Cancel</button>
        <button class="ua-button ua-button--primary" :disabled="busy" data-testid="ua-card-save" @click="click.saveEdit">Save</button>
      </div>
    </template>
    <p v-else class="ua-comment" data-testid="ua-card-comment">{{ annotation.comment }}</p>

    <ul v-if="annotation.thread.length" class="ua-thread" data-testid="ua-thread">
      <li
        v-for="message in annotation.thread"
        :key="message.id"
        class="ua-thread__item"
        :data-role="message.role"
        :data-kind="message.kind"
      >
        <span class="ua-thread__meta">{{ message.role }} · {{ KIND_LABEL[message.kind] ?? message.kind }}</span>
        <span v-if="message.body">{{ message.body }}</span>
      </li>
    </ul>

    <textarea
      :value="reply"
      class="ua-textarea"
      placeholder="Reply to the agent…"
      data-testid="ua-reply"
      @input="onReplyInput"
      @keydown="onReplyKeydown"
    />
    <div v-if="error" class="ua-error">{{ error }}</div>
    <div class="ua-actions">
      <button class="ua-button ua-button--danger" :disabled="busy" data-testid="ua-delete" @click="click.remove">Delete</button>
      <button v-if="!editing" class="ua-button" :disabled="busy" data-testid="ua-edit" @click="click.edit">Edit</button>
      <button v-if="isOpen" class="ua-button" :disabled="busy" data-testid="ua-dismiss" @click="click.dismiss">Dismiss</button>
      <button v-else class="ua-button" :disabled="busy" data-testid="ua-reopen" @click="click.reopen">Reopen</button>
      <button class="ua-button ua-button--primary" :disabled="busy || !reply.trim()" data-testid="ua-send-reply" @click="click.send">Send</button>
    </div>
  </div>
</template>
