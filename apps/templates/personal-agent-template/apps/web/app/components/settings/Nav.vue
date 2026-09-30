<script setup lang="ts">
const route = useRoute();

const items = [
  { label: "Profile", to: "/settings/profile", icon: "i-lucide-user-round" },
  { label: "Integrations", to: "/settings/integrations", icon: "i-lucide-plug" },
];

function isActive(path: string) {
  return route.path === path;
}
</script>

<template>
  <nav class="flex gap-1 border-b border-default">
    <NuxtLink
      v-for="item in items"
      :key="item.to"
      :to="item.to"
      class="relative -mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm transition-colors"
      :class="
        isActive(item.to)
          ? 'border-highlighted font-medium text-highlighted'
          : 'border-transparent text-muted hover:text-toned'
      "
    >
      <UIcon :name="item.icon" class="size-4 shrink-0" />
      {{ item.label }}
    </NuxtLink>
  </nav>
</template>
