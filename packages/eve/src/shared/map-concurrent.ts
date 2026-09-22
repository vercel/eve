/** Maps independent work in order, draining every started task before rejecting. */
export async function mapConcurrent<T, R>(
  values: readonly T[],
  operation: (value: T, index: number) => Promise<R>,
  concurrency = 8,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer.");
  }
  const results: R[] = [];
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (!failed && next < values.length) {
        const index = next++;
        try {
          results[index] = await operation(values[index]!, index);
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      }
    }),
  );
  if (failed) throw failure;
  return results;
}
