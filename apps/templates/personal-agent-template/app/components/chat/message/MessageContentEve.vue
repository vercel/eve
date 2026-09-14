<script setup lang="ts">
import {
  getToolName,
  isDynamicToolUIPart,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
} from "ai";
import type { UIMessage } from "ai";
import type { EveDynamicToolPart } from "eve/vue";
import { isPartStreaming, isToolStreaming } from "@nuxt/ui/utils/ai";
import type { AgentInputResponse } from "~/components/AgentInputRequest.vue";
import type { ChatStatus } from "~/composables/chat/types";
import { getMergedParts } from "~/utils/chat/ai";
import {
  hasVisibleParts,
  getToolDisplayName,
  normalizeEveParts,
  shouldShowToolInput,
} from "~/utils/chat/eve";
import { buildDisplayParts } from "~/utils/chat/save-memory";
import type { WeatherUIToolInvocation } from "~~/shared/utils/tools/weather";

const props = defineProps<{
  message: UIMessage;
  status: ChatStatus;
  isLast?: boolean;
  canRespond?: boolean;
}>();

const emit = defineEmits<{
  inputResponses: [responses: AgentInputResponse[]];
}>();

const rawParts = computed(() => props.message.parts);
const displayParts = computed(() =>
  buildDisplayParts(getMergedParts(normalizeEveParts(rawParts.value))),
);

const isBusy = computed(() => props.status === "submitted" || props.status === "streaming");

const showThinking = computed(
  () =>
    props.message.role === "assistant" &&
    props.isLast &&
    isBusy.value &&
    !hasVisibleParts(rawParts.value),
);
</script>

<template>
  <ChatActivityIndicator v-if="showThinking" />

  <template v-for="(entry, index) in displayParts" :key="`${message.id}-${entry.kind}-${index}`">
    <ChatToolSaveMemory
      v-if="entry.kind === 'save_memory'"
      :parts="entry.parts"
      :can-respond="canRespond ?? true"
      @input-responses="emit('inputResponses', $event)"
    />

    <template v-else>
      <UChatReasoning
        v-if="isReasoningUIPart(entry.part)"
        :text="entry.part.text"
        :streaming="isPartStreaming(entry.part)"
        chevron="leading"
      >
        <ChatComark :markdown="entry.part.text" :streaming="isPartStreaming(entry.part)" />
      </UChatReasoning>

      <template v-else-if="isToolUIPart(entry.part) || isDynamicToolUIPart(entry.part)">
        <ChatToolWeather
          v-if="getToolName(entry.part) === 'weather'"
          :invocation="{ ...(entry.part as WeatherUIToolInvocation) }"
          :streaming="isToolStreaming(entry.part)"
        />
        <UChatTool
          v-else-if="
            getToolName(entry.part) === 'web_search' || getToolName(entry.part) === 'google_search'
          "
          :text="isToolStreaming(entry.part) ? 'Searching the web...' : 'Searched the web'"
          :suffix="getSearchQuery(entry.part)"
          :streaming="isToolStreaming(entry.part)"
          chevron="leading"
        >
          <ChatToolSources :sources="getSources(entry.part)" />
        </UChatTool>
        <UChatTool
          v-else-if="getToolName(entry.part) !== 'ask_question'"
          :text="
            isDynamicToolUIPart(entry.part)
              ? getToolDisplayName(entry.part as EveDynamicToolPart)
              : getToolName(entry.part)
          "
          :streaming="isToolStreaming(entry.part)"
          chevron="leading"
          :default-open="
            entry.part.state === 'approval-requested' || entry.part.state === 'approval-responded'
          "
        >
          <AgentInputRequest
            v-if="isDynamicToolUIPart(entry.part)"
            :can-respond="canRespond ?? true"
            :part="entry.part as EveDynamicToolPart"
            @input-responses="emit('inputResponses', $event)"
          />

          <pre
            v-if="
              entry.part.input &&
              (!isDynamicToolUIPart(entry.part) ||
                shouldShowToolInput(entry.part as EveDynamicToolPart))
            "
            class="overflow-x-auto rounded-md bg-muted p-2 text-xs"
            >{{ JSON.stringify(entry.part.input, null, 2) }}</pre>

          <pre
            v-if="entry.part.output || entry.part.errorText"
            class="overflow-x-auto rounded-md bg-muted p-2 text-xs"
            :class="entry.part.errorText ? 'text-error' : ''"
            >{{ entry.part.errorText ?? JSON.stringify(entry.part.output, null, 2) }}</pre>
        </UChatTool>

        <AgentInputRequest
          v-else-if="isDynamicToolUIPart(entry.part)"
          compact
          :can-respond="canRespond ?? true"
          :part="entry.part as EveDynamicToolPart"
          @input-responses="emit('inputResponses', $event)"
        />
      </template>

      <template v-else-if="isTextUIPart(entry.part)">
        <div v-if="message.role === 'assistant'" class="relative">
          <ChatComark
            :key="
              isPartStreaming(entry.part)
                ? `${message.id}-text-${entry.part.text.length}`
                : `${message.id}-text-${index}`
            "
            :markdown="entry.part.text"
            :streaming="isPartStreaming(entry.part)"
          />
          <span
            v-if="isPartStreaming(entry.part) && isLast"
            class="ml-0.5 inline-block h-[1.1em] w-0.5 translate-y-px animate-pulse rounded-full bg-highlighted"
            aria-hidden="true"
          />
        </div>
        <p v-else class="whitespace-pre-wrap">
          {{ entry.part.text }}
        </p>
      </template>
    </template>
  </template>
</template>
