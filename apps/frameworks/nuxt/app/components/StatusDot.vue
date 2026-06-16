<script setup lang="ts">
import type { UseEveAgentStatus } from "eve/vue";

const props = defineProps<{
  status?: UseEveAgentStatus;
}>();

const isLive = computed(() => props.status === "submitted" || props.status === "streaming");

const tone = computed(() => {
  if (props.status === "error") return "bg-destructive";
  if (isLive.value) return "bg-sky-500";
  if (props.status === "ready") return "bg-emerald-500";
  return "bg-muted-foreground/50";
});
</script>

<template>
  <div class="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
    <span class="relative flex size-1.5">
      <span
        v-if="isLive"
        :class="[tone, 'absolute inline-flex size-full animate-ping rounded-full opacity-75']"
      />
      <span :class="[tone, 'relative inline-flex size-1.5 rounded-full']" />
    </span>
    <span>{{ status }}</span>
  </div>
</template>
