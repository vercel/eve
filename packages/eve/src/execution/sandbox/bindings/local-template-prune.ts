export function selectStaleTemplateEntries<T extends { readonly mtimeMs: number }>(
  entries: readonly T[],
  input: {
    readonly now: number;
    readonly recentWindowMs: number;
    readonly retainCount: number;
  },
): T[] {
  const sorted = [...entries].sort((left, right) => right.mtimeMs - left.mtimeMs);
  return sorted.filter(
    (entry, index) =>
      index >= input.retainCount && input.now - entry.mtimeMs > input.recentWindowMs,
  );
}

export const LOCAL_SANDBOX_TEMPLATE_RECENT_WINDOW_MS = 15 * 60 * 1000;
export const LOCAL_SANDBOX_TEMPLATE_RETAIN_COUNT = 5;
