<script setup lang="ts">
defineProps<{
  title: string;
  description?: string;
}>();
</script>

<template>
  <section>
    <div class="mb-3 flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h2 class="text-[10px] font-medium uppercase tracking-wider text-muted">
          {{ title }}
        </h2>
        <p v-if="description" class="mt-1 text-xs text-muted">
          {{ description }}
        </p>
      </div>

      <slot name="actions" />
    </div>

    <div class="divide-y divide-default rounded-lg border border-default">
      <slot />
    </div>
  </section>
</template>
