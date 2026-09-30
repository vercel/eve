<script setup lang="ts">
import type { ChatStatus } from "~/composables/chat/types";
import { useStreamLog } from "~/composables/chat/providers/eve/stream-log";

const props = defineProps<{
  status: ChatStatus;
}>();

const open = ref(false);
const isDev = import.meta.dev;
const { streamLog, turnEventCounts } = useStreamLog();

const counts = computed(() => [
  { key: "message.appended", label: "msg", value: turnEventCounts.value["message.appended"] ?? 0 },
  {
    key: "reasoning.appended",
    label: "reason",
    value: turnEventCounts.value["reasoning.appended"] ?? 0,
  },
  {
    key: "actions.requested",
    label: "tool",
    value: turnEventCounts.value["actions.requested"] ?? 0,
  },
  { key: "action.result", label: "result", value: turnEventCounts.value["action.result"] ?? 0 },
]);

const statusColor = computed(() => {
  if (props.status === "streaming" || props.status === "submitted") return "text-warning";
  if (props.status === "error") return "text-error";
  return "text-dimmed";
});

const root = ref<HTMLElement | null>(null);

function onDocumentClick(event: MouseEvent) {
  if (!open.value || !root.value) return;
  if (!root.value.contains(event.target as Node)) {
    open.value = false;
  }
}

onMounted(() => document.addEventListener("click", onDocumentClick));
onUnmounted(() => document.removeEventListener("click", onDocumentClick));
</script>

<template>
  <div v-if="isDev" ref="root" class="relative">
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted transition-colors hover:bg-elevated hover:text-highlighted"
      :class="open && 'bg-elevated text-highlighted'"
      @click="open = !open"
    >
      <span
        class="size-1.5 rounded-full bg-current"
        :class="[
          statusColor,
          (status === 'streaming' || status === 'submitted') && 'animate-pulse',
        ]"
      />
      <span class="font-mono">eve stream</span>
      <span class="text-dimmed">·</span>
      <span class="font-mono text-dimmed">{{ status }}</span>
      <UIcon
        :name="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'"
        class="size-3 text-dimmed"
      />
    </button>

    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0 translate-y-1"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition duration-100 ease-in"
      leave-from-class="opacity-100 translate-y-0"
      leave-to-class="opacity-0 translate-y-1"
    >
      <div
        v-if="open"
        class="absolute bottom-full left-0 z-20 mb-2 w-72 overflow-hidden rounded-lg border border-default bg-elevated shadow-lg"
      >
        <div class="border-b border-default px-3 py-2">
          <p class="text-xs font-medium text-highlighted">Stream inspector</p>
          <div class="mt-1.5 flex flex-wrap gap-1">
            <span
              v-for="item in counts"
              :key="item.key"
              class="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-dimmed"
            >
              {{ item.label }} {{ item.value }}
            </span>
          </div>
        </div>

        <ul class="max-h-40 space-y-px overflow-y-auto p-2 font-mono text-[11px] text-dimmed">
          <li
            v-for="(entry, index) in streamLog"
            :key="`${entry.at}-${index}`"
            class="truncate rounded px-1 py-0.5 hover:bg-muted/60"
          >
            {{ entry.type }}
          </li>
          <li v-if="streamLog.length === 0" class="px-1 py-2 text-center text-muted">
            No events yet
          </li>
        </ul>
      </div>
    </Transition>
  </div>
</template>
