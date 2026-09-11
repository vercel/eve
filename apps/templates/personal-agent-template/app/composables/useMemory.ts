import type { MemoryByCategory, MemoryEntry } from "#shared/types/memory";
import { MEMORY_EXPORT_PROMPT } from "#shared/memory/export-prompt";

interface MemoryResponse {
  memory: MemoryByCategory;
}

interface ImportMemoryResponse {
  created: MemoryEntry[];
  skipped: string[];
  memory: MemoryByCategory;
}

interface UpdateMemoryResponse {
  entry: MemoryEntry;
}

export function useMemory() {
  const { data, pending, error, refresh } = useFetch<MemoryResponse>("/api/memory", {
    key: "user-memory",
    ...payloadCacheOptions,
  });

  const memory = computed(() => data.value?.memory);

  async function importMemory(raw: string) {
    const result = await $fetch<ImportMemoryResponse>("/api/memory/import", {
      method: "POST",
      body: { raw },
    });
    await refresh();
    return result;
  }

  async function deleteEntry(id: string) {
    await $fetch(`/api/memory/${id}`, { method: "DELETE" });
    await refresh();
  }

  async function updateEntry(id: string, content: string) {
    const result = await $fetch<UpdateMemoryResponse>(`/api/memory/${id}`, {
      method: "PATCH",
      body: { content },
    });
    await refresh();
    return result.entry;
  }

  async function copyExportPrompt() {
    await navigator.clipboard.writeText(MEMORY_EXPORT_PROMPT);
  }

  return {
    memory,
    pending,
    error,
    refresh,
    importMemory,
    deleteEntry,
    updateEntry,
    copyExportPrompt,
    exportPrompt: MEMORY_EXPORT_PROMPT,
  };
}

export function formatMemoryDate(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp));
}
