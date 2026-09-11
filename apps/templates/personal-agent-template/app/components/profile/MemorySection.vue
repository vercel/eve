<script setup lang="ts">
import {
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_LABELS,
  type MemoryByCategory,
  type MemoryCategory,
  type MemoryEntry,
} from "#shared/types/memory";
import { formatMemoryDate } from "~/composables/useMemory";

const props = defineProps<{
  memory?: MemoryByCategory;
  pending?: boolean;
}>();

const importOpen = ref(false);
const deletingId = ref<string | null>(null);
const editingEntry = ref<MemoryEntry | null>(null);
const editContent = ref("");
const savingEdit = ref(false);
const expandedCategories = reactive(
  Object.fromEntries(MEMORY_CATEGORIES.map((category) => [category, false])) as Record<
    MemoryCategory,
    boolean
  >,
);
const expandedEntries = ref<Set<string>>(new Set());

const { deleteEntry, updateEntry } = useMemory();
const toast = useToast();

const PREVIEW_LENGTH = 100;
const COLLAPSED_CONTENT_LINES = 4;

const hasMemory = computed(() =>
  MEMORY_CATEGORIES.some((category) => (props.memory?.[category]?.length ?? 0) > 0),
);

const populatedCategories = computed(() =>
  MEMORY_CATEGORIES.filter((category) => entriesFor(category).length > 0),
);

function entriesFor(category: MemoryCategory) {
  return props.memory?.[category] ?? [];
}

function isCategoryOpen(category: MemoryCategory) {
  return expandedCategories[category];
}

function previewText(entries: MemoryEntry[]) {
  const text = entries
    .map((entry) => entry.content)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= PREVIEW_LENGTH) {
    return text;
  }
  return `${text.slice(0, PREVIEW_LENGTH).trimEnd()}…`;
}

function isEntryExpanded(id: string) {
  return expandedEntries.value.has(id);
}

function toggleEntry(id: string) {
  const next = new Set(expandedEntries.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  expandedEntries.value = next;
}

function isLongContent(content: string) {
  return content.length > PREVIEW_LENGTH || content.split("\n").length > COLLAPSED_CONTENT_LINES;
}

async function handleDelete(entry: MemoryEntry) {
  deletingId.value = entry.id;
  try {
    await deleteEntry(entry.id);
    toast.add({ title: "Memory entry removed", color: "neutral" });
  } catch {
    toast.add({ title: "Could not delete entry", color: "error" });
  } finally {
    deletingId.value = null;
  }
}

function openEdit(entry: MemoryEntry) {
  editingEntry.value = entry;
  editContent.value = entry.content;
}

function closeEdit() {
  editingEntry.value = null;
  editContent.value = "";
}

async function handleSaveEdit() {
  const entry = editingEntry.value;
  const content = editContent.value.trim();
  if (!entry || !content || savingEdit.value) {
    return;
  }

  savingEdit.value = true;
  try {
    await updateEntry(entry.id, content);
    toast.add({ title: "Memory updated", color: "neutral" });
    closeEdit();
  } catch {
    toast.add({ title: "Could not update entry", color: "error" });
  } finally {
    savingEdit.value = false;
  }
}
</script>

<template>
  <section>
    <SettingsSection
      title="Memory"
      description="Long-term context V uses across web, Slack, and iMessage."
    >
      <template v-if="hasMemory && !pending" #actions>
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-download"
          @click="
            () => {
              importOpen = true;
            }
          "
        >
          Import
        </UButton>
      </template>

      <template v-if="pending">
        <div class="space-y-2 px-4 py-4 sm:px-5">
          <USkeleton v-for="index in 3" :key="index" class="h-10 rounded-lg" />
        </div>
      </template>

      <div v-else-if="!hasMemory" class="px-4 py-8 text-center sm:px-5">
        <UIcon name="i-lucide-brain" class="mx-auto mb-3 size-7 text-dimmed" />
        <p class="text-sm text-muted">No memory yet.</p>
        <p class="mt-1 text-xs text-dimmed">
          Import from ChatGPT or let V suggest saving preferences in chat.
        </p>
        <UButton
          class="mt-4"
          color="neutral"
          variant="soft"
          size="sm"
          icon="i-lucide-download"
          @click="
            () => {
              importOpen = true;
            }
          "
        >
          Import Memory
        </UButton>
      </div>

      <template v-else>
        <UCollapsible
          v-for="category in populatedCategories"
          :key="category"
          v-model:open="expandedCategories[category]"
          :unmount-on-hide="false"
          class="border-b border-default last:border-b-0"
          :ui="{ content: 'overflow-hidden' }"
        >
          <button
            type="button"
            class="flex w-full items-start gap-2.5 px-4 py-3 text-left transition-colors sm:px-5"
            :class="isCategoryOpen(category) ? 'bg-accented' : 'hover:bg-accented/60'"
          >
            <UIcon
              name="i-lucide-chevron-down"
              class="mt-0.5 size-3.5 shrink-0 text-dimmed transition-transform duration-200"
              :class="{ '-rotate-180': isCategoryOpen(category) }"
            />

            <div class="min-w-0 flex-1">
              <div class="flex items-baseline justify-between gap-3">
                <p class="text-sm font-medium text-highlighted">
                  {{ MEMORY_CATEGORY_LABELS[category] }}
                </p>
              </div>

              <p v-if="!isCategoryOpen(category)" class="mt-0.5 line-clamp-1 text-xs text-muted">
                {{ previewText(entriesFor(category)) }}
              </p>
            </div>
          </button>

          <template #content>
            <div class="border-t border-default px-4 pb-4 pt-3 sm:px-5">
              <div v-if="entriesFor(category)[0]" class="group">
                <p
                  class="whitespace-pre-wrap text-sm leading-relaxed text-toned"
                  :class="
                    !isEntryExpanded(entriesFor(category)[0]!.id) &&
                    isLongContent(entriesFor(category)[0]!.content)
                      ? 'line-clamp-4'
                      : undefined
                  "
                >
                  {{ entriesFor(category)[0]!.content }}
                </p>

                <div class="mt-2 flex items-center gap-2">
                  <p class="text-[11px] text-dimmed">
                    {{ formatMemoryDate(entriesFor(category)[0]!.createdAt) }}
                    · {{ entriesFor(category)[0]!.source }}
                  </p>

                  <UButton
                    v-if="isLongContent(entriesFor(category)[0]!.content)"
                    color="neutral"
                    variant="link"
                    size="xs"
                    class="h-auto px-0 py-0 text-[11px]"
                    @click.stop="toggleEntry(entriesFor(category)[0]!.id)"
                  >
                    {{ isEntryExpanded(entriesFor(category)[0]!.id) ? "Less" : "More" }}
                  </UButton>

                  <UButton
                    color="neutral"
                    variant="link"
                    size="xs"
                    icon="i-lucide-pencil"
                    class="ms-auto h-auto px-0 py-0 text-[11px] opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label="Edit memory entry"
                    @click.stop="openEdit(entriesFor(category)[0]!)"
                  />

                  <UButton
                    color="neutral"
                    variant="link"
                    size="xs"
                    icon="i-lucide-trash-2"
                    class="h-auto px-0 py-0 text-[11px] opacity-0 transition-opacity group-hover:opacity-100"
                    :loading="deletingId === entriesFor(category)[0]!.id"
                    aria-label="Delete memory entry"
                    @click.stop="handleDelete(entriesFor(category)[0]!)"
                  />
                </div>
              </div>
            </div>
          </template>
        </UCollapsible>
      </template>
    </SettingsSection>

    <ProfileImportMemoryModal v-model:open="importOpen" />

    <UModal
      :open="editingEntry !== null"
      title="Edit memory"
      :ui="{ footer: 'justify-end gap-2' }"
      @update:open="
        (value) => {
          if (!value) closeEdit();
        }
      "
    >
      <template #body>
        <UTextarea
          v-model="editContent"
          :rows="8"
          autoresize
          class="w-full"
          placeholder="Memory content"
        />
      </template>

      <template #footer>
        <UButton color="neutral" variant="ghost" @click="closeEdit"> Cancel </UButton>
        <UButton
          color="neutral"
          :loading="savingEdit"
          :disabled="!editContent.trim()"
          @click="handleSaveEdit"
        >
          Save
        </UButton>
      </template>
    </UModal>
  </section>
</template>
