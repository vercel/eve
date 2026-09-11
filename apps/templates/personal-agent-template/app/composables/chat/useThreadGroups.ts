import type { ThreadSummary } from "#shared/types/thread";

interface ThreadGroup {
  id: string;
  label: string;
  items: ThreadSummary[];
}

function dayStart(timestamp: number) {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function useThreadGroups(threads: Ref<ThreadSummary[]> | ComputedRef<ThreadSummary[]>) {
  const groups = computed<ThreadGroup[]>(() => {
    const todayStart = dayStart(Date.now());
    const yesterdayStart = todayStart - 86_400_000;
    const weekStart = todayStart - 7 * 86_400_000;
    const monthStart = todayStart - 30 * 86_400_000;

    const today: ThreadSummary[] = [];
    const yesterday: ThreadSummary[] = [];
    const lastWeek: ThreadSummary[] = [];
    const lastMonth: ThreadSummary[] = [];
    const older: Record<string, ThreadSummary[]> = {};

    for (const thread of threads.value) {
      const at = dayStart(thread.updatedAt);

      if (at >= todayStart) {
        today.push(thread);
      } else if (at >= yesterdayStart) {
        yesterday.push(thread);
      } else if (at >= weekStart) {
        lastWeek.push(thread);
      } else if (at >= monthStart) {
        lastMonth.push(thread);
      } else {
        const label = new Intl.DateTimeFormat(undefined, {
          month: "long",
          year: "numeric",
        }).format(new Date(thread.updatedAt));

        (older[label] ??= []).push(thread);
      }
    }

    const result: ThreadGroup[] = [];

    if (today.length) result.push({ id: "today", label: "Today", items: today });
    if (yesterday.length) result.push({ id: "yesterday", label: "Yesterday", items: yesterday });
    if (lastWeek.length) result.push({ id: "last-week", label: "Last week", items: lastWeek });
    if (lastMonth.length) result.push({ id: "last-month", label: "Last month", items: lastMonth });

    for (const label of Object.keys(older).sort((a, b) => b.localeCompare(a))) {
      const items = older[label];
      if (items?.length) {
        result.push({ id: label, label, items });
      }
    }

    return result;
  });

  return { groups };
}
