<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import { authClient } from "~/lib/auth-client";

const session = authClient.useSession();

const user = computed(() => session.value?.data?.user);

const displayName = computed(
  () => user.value?.name?.trim() || user.value?.email?.split("@")[0] || "Account",
);

const items = computed<DropdownMenuItem[][]>(() => [
  [
    {
      label: "Settings",
      icon: "i-lucide-settings",
      to: "/settings/profile",
    },
    {
      label: "Integrations",
      icon: "i-lucide-plug",
      to: "/settings/integrations",
    },
  ],
  [
    {
      label: "Sign out",
      icon: "i-lucide-log-out",
      onSelect: signOut,
    },
  ],
]);

async function signOut() {
  await authClient.signOut();
  await navigateTo("/login");
}
</script>

<template>
  <UDropdownMenu
    v-if="user"
    :items
    :content="{ align: 'end', collisionPadding: 12 }"
    :ui="{ content: 'min-w-56 p-1' }"
  >
    <UButton
      color="neutral"
      variant="ghost"
      square
      class="rounded-full data-[state=open]:bg-elevated"
      :avatar="{
        alt: displayName,
        size: 'xs',
      }"
      aria-label="Account menu"
    />

    <template #content-top="{ sub }">
      <div v-if="!sub" class="px-2 pb-1 pt-1.5">
        <div class="flex items-center gap-2.5 px-1 py-1">
          <UAvatar :alt="displayName" size="sm" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-highlighted">
              {{ displayName }}
            </p>
            <p v-if="user?.email" class="truncate text-xs text-muted">
              {{ user.email }}
            </p>
          </div>
        </div>
        <USeparator class="mt-2" />
      </div>
    </template>
  </UDropdownMenu>
</template>
