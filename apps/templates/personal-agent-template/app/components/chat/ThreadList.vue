<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type { ThreadSummary } from "#shared/types/thread";
import { deleteThread } from "~/composables/chat/navigation";
import { useThreadGroups } from "~/composables/chat/useThreadGroups";

const props = defineProps<{
  threads: ThreadSummary[];
  pending?: boolean;
}>();

const emit = defineEmits<{
  refresh: [];
}>();

const route = useRoute();
const threadsRef = toRef(props, "threads");
const { groups } = useThreadGroups(threadsRef);

const deletingId = ref<string | null>(null);
const confirmOpen = ref(false);
const targetThread = ref<ThreadSummary | null>(null);

function isActive(id: string) {
  return route.params.id === id;
}

function contextItems(thread: ThreadSummary): DropdownMenuItem[][] {
  return [
    [
      {
        label: "Delete",
        icon: "i-lucide-trash-2",
        color: "error",
        onSelect: () => openDelete(thread),
      },
    ],
  ];
}

function openDelete(thread: ThreadSummary) {
  targetThread.value = thread;
  confirmOpen.value = true;
}

async function confirmDelete() {
  if (!targetThread.value) return;

  deletingId.value = targetThread.value.id;
  try {
    await deleteThread(targetThread.value.id);
    emit("refresh");
  } finally {
    deletingId.value = null;
    confirmOpen.value = false;
    targetThread.value = null;
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div v-if="pending && !threads.length" class="px-3 py-1 text-sm text-muted">Loading…</div>

    <p v-else-if="!threads.length" class="px-3 py-1 text-sm text-muted">No chats yet.</p>

    <UScrollArea v-else class="min-h-0 flex-1">
      <nav class="flex flex-col gap-px p-1.5">
        <template v-for="(group, groupIndex) in groups" :key="group.id">
          <p
            class="px-2.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted"
            :class="groupIndex > 0 && 'mt-2 border-t border-default pt-3'"
          >
            {{ group.label }}
          </p>

          <UContextMenu
            v-for="thread in group.items"
            :key="thread.id"
            :items="contextItems(thread)"
            size="sm"
          >
            <NuxtLink
              :to="`/chat/${thread.id}`"
              class="flex items-center gap-1.5 overflow-hidden rounded-md px-2 py-1 text-sm transition-colors"
              :class="
                isActive(thread.id)
                  ? 'bg-linear-to-r from-elevated to-elevated/0 text-highlighted brightness-125'
                  : 'text-muted hover:bg-linear-to-r hover:from-elevated hover:to-elevated/0'
              "
            >
              <span class="truncate">{{ thread.title }}</span>
            </NuxtLink>
          </UContextMenu>
        </template>
      </nav>
    </UScrollArea>

    <UModal
      v-model:open="confirmOpen"
      title="Delete chat?"
      :description="`“${targetThread?.title}” will be removed from your history. This cannot be undone.`"
    >
      <template #footer>
        <UButton
          color="neutral"
          variant="outline"
          label="Cancel"
          @click="
            () => {
              confirmOpen = false;
            }
          "
        />
        <UButton color="error" label="Delete" :loading="!!deletingId" @click="confirmDelete" />
      </template>
    </UModal>
  </div>
</template>
