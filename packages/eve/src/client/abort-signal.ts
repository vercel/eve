/** Throws the signal's abort reason without requiring AbortSignal#throwIfAborted support. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal === undefined) return;

  const nativeThrowIfAborted = (signal as { readonly throwIfAborted?: unknown }).throwIfAborted;
  if (typeof nativeThrowIfAborted === "function") {
    nativeThrowIfAborted.call(signal);
    return;
  }

  if (!signal.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;

  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  throw error;
}
