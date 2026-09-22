import type { ThreadSummary } from "#shared/types/thread";
import { THREAD_LIST_KEY, deleteThread, refreshThreadList } from "~/composables/chat/navigation";

interface ThreadListResponse {
  threads: ThreadSummary[];
}

export function useThreadList() {
  const { data, pending, refresh, error } = useFetch<ThreadListResponse>("/api/threads", {
    key: THREAD_LIST_KEY,
    ...payloadCacheOptions,
  });

  const threads = computed(() => data.value?.threads ?? []);

  return {
    threads,
    pending,
    error,
    refresh,
    refreshThreadList,
    deleteThread,
  };
}

export function formatThreadTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}
