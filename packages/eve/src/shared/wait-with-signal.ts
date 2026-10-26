/** Stops waiting without claiming to cancel work whose owner does not accept a signal. */
export async function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return await promise;
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([aborted.promise, promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
