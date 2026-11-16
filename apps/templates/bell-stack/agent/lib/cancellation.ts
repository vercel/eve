export class BrowserCancellationError extends Error {
  override readonly name = "AbortError";

  constructor() {
    super("The browser operation was canceled.");
  }
}

type Outcome<T> =
  | { kind: "completed"; value: T }
  | { kind: "failed"; error: unknown }
  | { kind: "canceled"; cleanup: Promise<void> };

/**
 * Stop an in-flight operation and wait for its cleanup before the tool settles.
 * The abort listener is removed for every terminal path.
 */
export async function runWithCancellation<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  if (signal.aborted) {
    await cleanup().catch(() => undefined);
    throw new BrowserCancellationError();
  }

  let onAbort!: () => void;
  const canceled = new Promise<Outcome<T>>((resolve) => {
    onAbort = () => {
      const cleanupPromise = cleanup().catch(() => undefined);
      resolve({ kind: "canceled", cleanup: cleanupPromise });
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const pending: Promise<Outcome<T>> = Promise.resolve()
    .then(() => {
      if (signal.aborted) throw new BrowserCancellationError();
      return operation();
    })
    .then(
      (value): Outcome<T> => ({ kind: "completed", value }),
      (error): Outcome<T> => ({ kind: "failed", error }),
    );

  try {
    const outcome = await Promise.race([pending, canceled]);
    if (outcome.kind === "canceled") {
      await outcome.cleanup;
      throw new BrowserCancellationError();
    }
    if (outcome.kind === "failed") throw outcome.error;
    return outcome.value;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
