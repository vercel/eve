<script setup lang="ts">
const props = defineProps<{
  text: string;
  isStreaming: boolean;
}>();

const isOpen = ref(true);

watch(
  () => props.isStreaming,
  (streaming) => {
    if (streaming) isOpen.value = true;
  },
);
</script>

<template>
  <div class="w-full">
    <button
      type="button"
      class="flex w-full items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
      @click="isOpen = !isOpen"
    >
      <svg class="size-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path
          d="M12 2a8 8 0 0 0-8 8c0 3.4 2.1 6.3 5 7.5V20h6v-2.5c2.9-1.2 5-4.1 5-7.5a8 8 0 0 0-8-8z"
        />
        <path d="M9.5 22h5" />
      </svg>
      <span v-if="isStreaming" class="italic">Thinking…</span>
      <span v-else>Thought</span>
      <svg
        class="size-4 transition-transform"
        :class="isOpen ? 'rotate-180' : ''"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        viewBox="0 0 24 24"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
    <div v-if="isOpen" class="mt-2 text-sm text-muted-foreground">
      <div class="whitespace-pre-wrap">{{ text }}</div>
    </div>
  </div>
</template>
