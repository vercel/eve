<script setup lang="ts">
import type { EveDynamicToolPart } from "eve/vue";
import { MEMORY_CATEGORY_LABELS, type MemoryCategory } from "#shared/types/memory";
import type { AgentInputResponse } from "~/components/AgentInputRequest.vue";
import { isSaveMemoryPending, normalizeSaveMemoryInput } from "~/utils/chat/save-memory";

interface SaveMemoryResult {
  category: string;
  saved: boolean;
}

interface SaveMemoryOutput {
  results?: SaveMemoryResult[];
}

const props = defineProps<{
  parts: EveDynamicToolPart[];
  canRespond?: boolean;
}>();

const emit = defineEmits<{
  inputResponses: [responses: AgentInputResponse[]];
}>();

const expanded = ref(false);

const pendingParts = computed(() => props.parts.filter(isSaveMemoryPending));

const isPendingApproval = computed(() => pendingParts.value.length > 0);

const normalized = computed(() => {
  const updates = props.parts.flatMap(
    (part) =>
      normalizeSaveMemoryInput(part.input as Parameters<typeof normalizeSaveMemoryInput>[0])
        .updates,
  );

  const reason =
    props.parts
      .map(
        (part) =>
          normalizeSaveMemoryInput(part.input as Parameters<typeof normalizeSaveMemoryInput>[0])
            .reason,
      )
      .find((value) => value.length > 0) ?? "";

  return { reason, updates };
});

const hasDetails = computed(() =>
  normalized.value.updates.some((update) => update.content?.trim()),
);

function categoryLabel(category?: string) {
  if (category && category in MEMORY_CATEGORY_LABELS) {
    return MEMORY_CATEGORY_LABELS[category as MemoryCategory];
  }

  return "Memory";
}

const allSaved = computed(() => props.parts.every((part) => part.state === "output-available"));

function saveResultsForPart(part: EveDynamicToolPart): SaveMemoryResult[] {
  if (part.state !== "output-available") {
    return [];
  }

  const output = part.output as SaveMemoryOutput | undefined;
  return output?.results ?? [];
}

const saveResults = computed(() => props.parts.flatMap((part) => saveResultsForPart(part)));

const allUnchanged = computed(
  () =>
    allSaved.value &&
    saveResults.value.length > 0 &&
    saveResults.value.every((result) => !result.saved),
);

const allDeclined = computed(() =>
  props.parts.every(
    (part) =>
      part.state === "output-denied" || part.toolMetadata?.eve?.inputResponse?.optionId === "deny",
  ),
);

const hasError = computed(() => props.parts.some((part) => part.state === "output-error"));

const statusLabel = computed(() => {
  if (isPendingApproval.value) {
    return pendingParts.value.length > 1 ? `Review (${pendingParts.value.length})` : "Review";
  }
  if (hasError.value) {
    return "Failed";
  }
  if (allDeclined.value) {
    return "Skipped";
  }
  if (allSaved.value) {
    return allUnchanged.value ? "Unchanged" : "Saved";
  }
  return "Saving…";
});

const statusDotClass = computed(() => {
  if (hasError.value) {
    return "bg-red-400/90";
  }
  if (allDeclined.value) {
    return "bg-neutral-400/90";
  }
  if (allSaved.value) {
    return allUnchanged.value ? "bg-neutral-400/90" : "bg-emerald-400/90";
  }
  return "bg-amber-400/90";
});

const rememberLabel = computed(() =>
  pendingParts.value.length > 1 ? `Remember all (${pendingParts.value.length})` : "Remember",
);

const skipLabel = computed(() => (pendingParts.value.length > 1 ? "Skip all" : "Skip"));

const errorText = computed(() =>
  props.parts
    .map((part) => part.errorText)
    .filter(Boolean)
    .join(" "),
);

function respond(optionId: "approve" | "deny") {
  const responses = pendingParts.value.flatMap((part) => {
    const requestId = part.toolMetadata?.eve?.inputRequest?.requestId;
    return requestId ? [{ optionId, requestId }] : [];
  });

  if (!responses.length) {
    return;
  }

  emit("inputResponses", responses);
}

watch(allSaved, (saved) => {
  if (saved && !allUnchanged.value) {
    refreshNuxtData("user-memory");
  }
});
</script>

<template>
  <div
    class="my-1 w-full max-w-xl overflow-hidden rounded-lg border border-default/70 bg-elevated/30"
    :class="isPendingApproval ? 'border-amber-500/15' : ''"
  >
    <div class="flex items-start gap-2.5 px-3 py-2.5">
      <div
        class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-default/60 bg-default/50"
      >
        <UIcon name="i-lucide-brain" class="size-3.5 text-toned" />
      </div>

      <div class="min-w-0 flex-1 space-y-1.5">
        <div class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <p class="text-xs font-medium text-highlighted">Save to memory</p>
          <span class="inline-flex items-center gap-1 text-[11px] text-dimmed">
            <span class="size-1.5 shrink-0 rounded-full" :class="statusDotClass" />
            {{ statusLabel }}
          </span>
        </div>

        <div v-if="normalized.updates.length" class="flex flex-wrap gap-1">
          <UBadge
            v-for="(update, index) in normalized.updates"
            :key="`${update.category}-${index}`"
            color="neutral"
            variant="subtle"
            size="xs"
          >
            {{ categoryLabel(update.category) }}
          </UBadge>
        </div>

        <p v-if="normalized.reason" class="text-xs leading-snug text-muted">
          {{ normalized.reason }}
        </p>

        <button
          v-if="hasDetails && isPendingApproval"
          type="button"
          class="inline-flex items-center gap-1 text-[11px] text-dimmed transition-colors hover:text-toned"
          @click="expanded = !expanded"
        >
          <UIcon
            name="i-lucide-chevron-down"
            class="size-3 transition-transform duration-200"
            :class="{ '-rotate-180': expanded }"
          />
          {{ expanded ? "Hide full text" : "Show full text" }}
        </button>

        <p v-if="hasError && errorText" class="text-[11px] text-error">
          {{ errorText }}
        </p>
      </div>
    </div>

    <div v-if="expanded && hasDetails" class="border-t border-default/50 bg-default/20 px-3 py-2">
      <ul class="space-y-2">
        <li
          v-for="(update, index) in normalized.updates"
          :key="`detail-${update.category}-${index}`"
        >
          <p class="text-[11px] font-medium text-toned">
            {{ categoryLabel(update.category) }}
          </p>
          <p class="mt-0.5 line-clamp-4 whitespace-pre-wrap text-[11px] leading-relaxed text-muted">
            {{ update.content }}
          </p>
        </li>
      </ul>
    </div>

    <div
      v-if="isPendingApproval"
      class="flex justify-end gap-1.5 border-t border-default/50 px-3 py-2"
    >
      <UButton
        color="neutral"
        variant="ghost"
        size="xs"
        :disabled="!canRespond"
        @click="respond('deny')"
      >
        {{ skipLabel }}
      </UButton>
      <UButton color="neutral" size="xs" :disabled="!canRespond" @click="respond('approve')">
        {{ rememberLabel }}
      </UButton>
    </div>
  </div>
</template>
