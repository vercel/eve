<script setup lang="ts">
import type { EveDynamicToolPart } from "eve/vue";

export type AgentInputResponse = {
  optionId?: string;
  requestId: string;
  text?: string;
};

const props = defineProps<{
  canRespond: boolean;
  part: EveDynamicToolPart;
  compact?: boolean;
}>();

const emit = defineEmits<{
  inputResponses: [responses: AgentInputResponse[]];
}>();

const inputRequest = computed(() => props.part.toolMetadata?.eve?.inputRequest);
const inputResponse = computed(() => props.part.toolMetadata?.eve?.inputResponse);

const hidePrompt = computed(() => !props.compact && props.part.toolName === "ask_question");

const showOptions = computed(() => (inputRequest.value?.options?.length ?? 0) > 0);

const showFreeform = computed(() => {
  const request = inputRequest.value;
  if (!request || inputResponse.value) {
    return false;
  }
  return request.allowFreeform === true || request.display === "text" || !showOptions.value;
});

const freeformText = ref("");

const canSubmitFreeform = computed(() => props.canRespond && freeformText.value.trim().length > 0);

const selectedOption = computed(() => {
  const request = inputRequest.value;
  const response = inputResponse.value;
  if (!request?.options || !response?.optionId) {
    return undefined;
  }
  return request.options.find((option) => option.id === response.optionId);
});

const responseLabel = computed(
  () => selectedOption.value?.label ?? inputResponse.value?.text ?? inputResponse.value?.optionId,
);

function respond(optionId: string, requestId: string) {
  emit("inputResponses", [{ optionId, requestId }]);
}

function respondText() {
  const request = inputRequest.value;
  const text = freeformText.value.trim();
  if (!request || !text) {
    return;
  }
  emit("inputResponses", [{ requestId: request.requestId, text }]);
}

function onFreeformKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (canSubmitFreeform.value) {
      respondText();
    }
  }
}
</script>

<template>
  <div
    v-if="inputRequest"
    :class="
      compact
        ? 'mt-2 max-w-lg space-y-2'
        : 'space-y-3 rounded-lg border border-default/60 bg-elevated/40 p-3'
    "
  >
    <p v-if="!hidePrompt" :class="compact ? 'text-sm text-muted' : 'text-sm text-muted'">
      {{ inputRequest.prompt }}
    </p>

    <p v-if="inputResponse" class="text-sm text-muted">
      <span class="text-dimmed">Answered</span>
      <span class="mx-1.5 text-dimmed">·</span>
      <span class="text-highlighted">{{ responseLabel }}</span>
    </p>

    <template v-else>
      <div v-if="showOptions" class="flex flex-wrap gap-1.5">
        <UButton
          v-for="option in inputRequest.options"
          :key="option.id"
          :color="option.style === 'danger' ? 'error' : 'neutral'"
          :variant="compact ? 'soft' : 'solid'"
          :disabled="!canRespond"
          size="xs"
          @click="respond(option.id, inputRequest.requestId)"
        >
          {{ option.label }}
        </UButton>
      </div>

      <form
        v-if="showFreeform"
        :class="compact ? 'flex items-center gap-2' : 'space-y-2'"
        @submit.prevent="respondText"
      >
        <UInput
          v-if="compact"
          v-model="freeformText"
          class="min-w-0 flex-1"
          size="sm"
          :disabled="!canRespond"
          placeholder="Your answer"
          @keydown="onFreeformKeydown"
        />
        <UTextarea
          v-else
          v-model="freeformText"
          :rows="showOptions ? 2 : 3"
          autoresize
          class="w-full"
          :disabled="!canRespond"
          placeholder="Type your answer"
          @keydown="onFreeformKeydown"
        />
        <UButton
          type="submit"
          size="sm"
          :icon="compact ? 'i-lucide-arrow-up' : undefined"
          :disabled="!canSubmitFreeform"
          :class="compact ? 'shrink-0' : undefined"
        >
          <span v-if="!compact">Submit</span>
        </UButton>
      </form>
    </template>
  </div>
</template>
