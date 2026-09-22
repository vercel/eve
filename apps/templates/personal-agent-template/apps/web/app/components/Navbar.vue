<script setup lang="ts">
import { startNewChat } from "~/composables/chat/navigation";
</script>

<template>
  <UDashboardNavbar
    class="pointer-events-none absolute inset-x-0 top-0 z-10 border-b-0 backdrop-blur sm:px-4 lg:backdrop-blur-none"
    :ui="{ left: 'pointer-events-auto min-w-0', right: 'pointer-events-auto gap-1' }"
  >
    <template #left>
      <slot name="title" />
    </template>

    <template #right>
      <slot />

      <UserMenu />

      <UColorModeButton />

      <UButton
        color="neutral"
        variant="ghost"
        icon="i-lucide-circle-plus"
        class="lg:hidden"
        aria-label="New chat"
        @click="startNewChat()"
      />
    </template>
  </UDashboardNavbar>
</template>
