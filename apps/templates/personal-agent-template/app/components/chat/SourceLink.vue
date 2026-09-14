<script setup lang="ts">
defineProps<{
  url: string;
  favicon: string;
  label: string;
}>();
</script>

<template>
  <UButton
    :to="url"
    target="_blank"
    :avatar="{ src: favicon }"
    :label="label"
    trailing-icon="i-lucide-arrow-up-right"
    size="xs"
    color="neutral"
    variant="outline"
    class="rounded-full align-middle"
  />
</template>
