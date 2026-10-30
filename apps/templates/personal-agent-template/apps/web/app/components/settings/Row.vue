<script setup lang="ts">
defineProps<{
  label: string;
  description?: string;
  hint?: string;
  inline?: boolean;
}>();
</script>

<template>
  <div class="px-4 py-3" :class="inline ? 'flex items-center justify-between gap-4' : undefined">
    <div class="min-w-0" :class="inline ? 'flex-1' : 'mb-3'">
      <p class="text-sm text-highlighted">
        {{ label }}
      </p>
      <p v-if="description" class="mt-0.5 text-xs text-muted">
        {{ description }}
      </p>
    </div>

    <div v-if="$slots.default" class="min-w-0" :class="inline ? 'shrink-0' : 'w-full'">
      <slot />
      <p v-if="hint" class="mt-1.5 text-xs text-dimmed">
        {{ hint }}
      </p>
    </div>

    <slot v-else name="control" />
  </div>
</template>
