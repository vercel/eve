<script setup lang="ts">
const open = defineModel<boolean>("open", { default: false });

const emit = defineEmits<{
  imported: [count: number];
}>();

const { importMemory, copyExportPrompt } = useMemory();
const toast = useToast();

const raw = ref("");
const importing = ref(false);
const copied = ref(false);

watch(open, (value) => {
  if (!value) {
    copied.value = false;
  }
});

async function handleCopyPrompt() {
  try {
    await copyExportPrompt();
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    toast.add({
      title: "Could not copy prompt",
      color: "error",
    });
  }
}

async function handleImport() {
  const text = raw.value.trim();
  if (!text || importing.value) {
    return;
  }

  importing.value = true;
  try {
    const result = await importMemory(text);
    raw.value = "";
    open.value = false;
    emit("imported", result.created.length);
    toast.add({
      title: result.created.length
        ? `Added ${result.created.length} memory ${result.created.length === 1 ? "entry" : "entries"}`
        : "Nothing new to add",
      description: result.skipped.length
        ? `${result.skipped.length} section(s) were already stored.`
        : undefined,
      color: result.created.length ? "success" : "neutral",
    });
  } catch (error) {
    toast.add({
      title: "Import failed",
      description: error instanceof Error ? error.message : "Try again.",
      color: "error",
    });
  } finally {
    importing.value = false;
  }
}

defineShortcuts({
  meta_enter: () => {
    if (open.value) {
      void handleImport();
    }
  },
});
</script>

<template>
  <UModal
    v-model:open="open"
    title="Import Memory"
    :ui="{
      content: 'w-[calc(100vw-2rem)] max-w-2xl',
      body: 'space-y-4 px-5 py-4 sm:px-6',
      footer: 'justify-end gap-2 px-5 py-3 sm:px-6',
    }"
  >
    <template #actions>
      <UButton
        color="neutral"
        variant="outline"
        size="sm"
        :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
        @click="handleCopyPrompt"
      >
        {{ copied ? "Copied" : "Copy Prompt" }}
      </UButton>
    </template>

    <template #body>
      <ol
        class="list-decimal space-y-1.5 ps-5 text-sm leading-relaxed text-toned marker:text-dimmed"
      >
        <li>Click the "Copy Prompt" button</li>
        <li>Go to your AI provider, and paste it into a new chat</li>
        <li>Paste the response below and add it to your V memory</li>
      </ol>

      <p class="text-xs leading-relaxed text-dimmed">
        Importing memory is additive. You can do it for all your other AI providers.
      </p>

      <UTextarea
        v-model="raw"
        class="w-full"
        :rows="8"
        placeholder="Paste your memory export here..."
      />
    </template>

    <template #footer>
      <UButton
        color="neutral"
        variant="ghost"
        @click="
          () => {
            open = false;
          }
        "
      >
        Cancel
      </UButton>

      <UButton color="primary" :disabled="!raw.trim()" :loading="importing" @click="handleImport">
        Add to Memory
        <span class="ms-2 inline-flex items-center gap-0.5 opacity-80">
          <UKbd value="meta" size="sm" variant="subtle" />
          <UKbd size="sm" variant="subtle"> ↵ </UKbd>
        </span>
      </UButton>
    </template>
  </UModal>
</template>
