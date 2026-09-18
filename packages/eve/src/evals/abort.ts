/** Stop waiting at the eval deadline even if a provider ignores cancellation. */
export async function runUntilAborted<T>(
  task: T | PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([aborted, task]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}
