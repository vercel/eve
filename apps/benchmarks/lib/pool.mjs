/**
 * Runs `worker` over `items` with at most `concurrency` in flight, starting the
 * next item as soon as any running one settles. Resolves with each item's
 * result in input order; a rejected worker is reported, not rethrown.
 */
export async function runPool(items, concurrency, worker) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive integer.");
  }
  const results = Array.from({ length: items.length });
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { status: "rejected", reason: error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
}
