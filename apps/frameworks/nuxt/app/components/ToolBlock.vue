<script setup lang="ts">
import type { EveToolPart } from "eve/vue";

const props = defineProps<{
  part: EveToolPart;
  canRespond: boolean;
}>();

const emit = defineEmits<{
  answers: [
    responses: readonly {
      readonly optionId?: string;
      readonly interactionId: string;
      readonly text?: string;
    }[],
  ];
}>();

const interaction = computed(() => props.part.interaction?.request);
const answer = computed(() => props.part.interaction?.answer);
const awaitingApproval = computed(
  () => interaction.value?.kind === "approval" && props.part.interaction?.status !== "settled",
);
const errorText = computed(() =>
  props.part.state === "failed" ||
  props.part.state === "rejected" ||
  props.part.state === "cancelled"
    ? (props.part.error?.message ?? props.part.state)
    : undefined,
);

const isOpen = ref(props.part.interaction !== undefined);

const title = computed(() => props.part.label);

const stateLabel = computed(() => {
  if (props.part.state === "streaming") return "Pending";
  if (awaitingApproval.value) return "Awaiting Approval";

  const labels: Record<string, string> = {
    requested: "Pending",
    running: "Running",
    approval: "Awaiting Approval",
    blocked: "Awaiting Input",
    completed: "Completed",
    failed: "Error",
    rejected: "Denied",
    cancelled: "Cancelled",
  };
  return labels[props.part.state] ?? props.part.state;
});

const stateColor = computed(() => {
  if (props.part.state === "completed") return "text-emerald-600";
  if (
    props.part.state === "failed" ||
    props.part.state === "rejected" ||
    props.part.state === "cancelled"
  )
    return "text-destructive";
  if (awaitingApproval.value) return "text-yellow-600";
  return "text-muted-foreground";
});
const selectedOption = computed(() =>
  interaction.value?.options?.find((option) => option.id === answer.value?.optionId),
);

const formattedInput = computed(() => JSON.stringify(props.part.input, null, 2));
const formattedOutput = computed(() => {
  if (typeof props.part.output === "object") return JSON.stringify(props.part.output, null, 2);
  return String(props.part.output ?? "");
});
</script>

<template>
  <div class="w-full rounded-md border">
    <button
      type="button"
      class="flex w-full items-center justify-between gap-4 p-3"
      @click="isOpen = !isOpen"
    >
      <div class="flex items-center gap-2">
        <svg
          class="size-4 text-muted-foreground"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          viewBox="0 0 24 24"
        >
          <path
            d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
          />
        </svg>
        <span class="text-sm font-medium">{{ title }}</span>
        <span class="rounded-full bg-secondary px-2 py-0.5 text-xs" :class="stateColor">
          {{ stateLabel }}
        </span>
      </div>
      <svg
        class="size-4 text-muted-foreground transition-transform"
        :class="isOpen ? 'rotate-180' : ''"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        viewBox="0 0 24 24"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>

    <div v-if="isOpen" class="border-t">
      <div class="space-y-2 overflow-hidden p-4">
        <h4 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Parameters
        </h4>
        <pre class="overflow-x-auto rounded-md bg-muted/50 p-3 text-xs">{{ formattedInput }}</pre>
      </div>

      <div
        v-if="interaction"
        class="space-y-3 rounded-md border-y border-yellow-500/30 bg-yellow-500/5 p-3"
      >
        <p class="text-sm text-muted-foreground">
          {{ interaction.prompt }}
        </p>
        <p v-if="answer" class="text-sm font-medium">
          Responded:
          {{ selectedOption?.label ?? answer.text ?? answer.optionId }}
        </p>
        <div v-else class="flex flex-wrap gap-2">
          <button
            v-for="option in interaction.options"
            :key="option.id"
            :disabled="!canRespond"
            type="button"
            class="rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50"
            :class="
              option.style === 'danger'
                ? 'bg-destructive text-white hover:bg-destructive/90'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            "
            @click="
              emit('answers', [
                { optionId: option.id, interactionId: part.interaction!.interactionId },
              ])
            "
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <div v-if="part.output || errorText" class="space-y-2 p-4">
        <h4 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {{ errorText ? "Error" : "Result" }}
        </h4>
        <div v-if="errorText" class="rounded-md bg-destructive/10 p-3 text-xs text-destructive">
          {{ errorText }}
        </div>
        <pre v-else class="overflow-x-auto rounded-md bg-muted/50 p-3 text-xs">{{
          formattedOutput
        }}</pre>
      </div>
    </div>
  </div>
</template>
